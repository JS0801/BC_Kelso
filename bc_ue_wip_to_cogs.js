/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */
define(['N/record', 'N/search', 'N/log', 'N/format'], (record, search, log, format) => {

  const CFG = {
    WIP_ACCOUNT: '1806',
    SUBSIDIARIES: ['39', '57', '11', '59', '6'],
    APPROVED: '2',
    ITEM_COGS: 'custitem_bc_cogsmapping',
    RELATED_JE: 'custbody_bc_related_transaction',
    LINE_SOURCE: 'custcol_bc_related_transaction',
    LINE_SOURCE_ID: 'custcol_bc_related_tran_line_id',
    CUSTOMER_TYPE: 'cseg_kelso_custseg1',
    SERVICE_TYPE: 'cseg1'
  };

  const afterSubmit = (context) => {
    try {
      if (context.type === context.UserEventType.DELETE) {
        const jeId = context.oldRecord.getValue({ fieldId: CFG.RELATED_JE }) ||
          findSourceJe(context.oldRecord.id);
        if (jeId) reverseJe(jeId, `Invoice ${context.oldRecord.id} deleted`, true);
        return;
      }

      if (context.type !== context.UserEventType.CREATE &&
          context.type !== context.UserEventType.EDIT &&
          context.type !== context.UserEventType.APPROVE) return;

      const invoice = context.newRecord;
      const newStatus = String(invoice.getValue({ fieldId: 'approvalstatus' }) || '');
      const oldStatus = context.oldRecord
        ? String(context.oldRecord.getValue({ fieldId: 'approvalstatus' }) || '')
        : '';

      // if (newStatus !== CFG.APPROVED) return;
      // if (context.type !== context.UserEventType.APPROVE && oldStatus === CFG.APPROVED) return;

      const invoiceId = invoice.id;
      const projectId = invoice.getValue({ fieldId: 'job' });
      const subsidiary = String(invoice.getValue({ fieldId: 'subsidiary' }) || '');

      if (!projectId || !CFG.SUBSIDIARIES.includes(subsidiary)) return;
      if (findSourceJe(invoiceId)) return;

      const activeJeSearch = search.create({
        type: search.Type.INVOICE,
        settings: [{ name: 'consolidationtype', value: 'ACCTTYPE' }],
        filters: [
          ['type', 'anyof', 'CustInvc'], 'AND',
          ['jobmain.internalid', 'anyof', projectId], 'AND',
          ['mainline', 'is', 'T'], 'AND',
          [`${CFG.RELATED_JE}.isreversal`, 'is', 'F'], 'AND',
          [`${CFG.RELATED_JE}.reversaldate`, 'isempty', '']
        ],
        columns: [
          search.createColumn({ name: 'internalid', summary: search.Summary.GROUP }),
          search.createColumn({ name: CFG.RELATED_JE, summary: search.Summary.MAX })
        ]
      });

      if (activeJeSearch.runPaged({ pageSize: 1000 }).count > 0) {
        log.audit({
          title: 'WIP relief skipped',
          details: `Project ${projectId} already has an Invoice with an active WIP relief JE.`
        });
        return;
      }

      const costs = [];
      const costSearch = search.create({
        type: search.Type.VENDOR_BILL,
        settings: [{ name: 'consolidationtype', value: 'ACCTTYPE' }],
        filters: [
          ['account', 'anyof', CFG.WIP_ACCOUNT], 'AND',
          ['subsidiary', 'anyof', CFG.SUBSIDIARIES], 'AND',
          ['job.internalid', 'anyof', projectId], 'AND',
          ['posting', 'is', 'T'], 'AND',
          [
            [CFG.RELATED_JE, 'anyof', '@NONE@'], 'OR',
            [`${CFG.RELATED_JE}.isreversal`, 'is', 'T'], 'OR',
            [`${CFG.RELATED_JE}.reversaldate`, 'isnotempty', '']
          ]
        ],
        columns: [
          'debitamount',
          'creditamount',
          'department',
          'class',
          'location',
          CFG.CUSTOMER_TYPE,
          CFG.SERVICE_TYPE,
          'lineuniquekey',
          search.createColumn({ name: CFG.ITEM_COGS, join: 'item' })
        ]
      });

      const pages = costSearch.runPaged({ pageSize: 1000 });
      pages.pageRanges.forEach((page) => {
        pages.fetch({ index: page.index }).data.forEach((result) => {
          const amount = round(
            Number(result.getValue({ name: 'debitamount' }) || 0) -
            Number(result.getValue({ name: 'creditamount' }) || 0)
          );

          if (!amount) return;
          costs.push({
            billId: result.id,
            lineId: result.getValue({ name: 'lineuniquekey' }),
            cogs: result.getValue({ name: CFG.ITEM_COGS, join: 'item' }),
            amount,
            department: result.getValue({ name: 'department' }),
            classId: result.getValue({ name: 'class' }),
            location: result.getValue({ name: 'location' }),
            customerType: result.getValue({ name: CFG.CUSTOMER_TYPE }),
            serviceType: result.getValue({ name: CFG.SERVICE_TYPE })
          });
        });
      });

      if (!costs.length) {
        log.audit({ title: 'WIP relief skipped', details: `No unprocessed WIP Bills found for Project ${projectId}.` });
        return;
      }

      const missing = costs.filter((line) => !line.cogs);
      if (missing.length) {
        log.error({
          title: 'WIP relief not created',
          details: `Missing COGS mapping on ${missing.length} Bill line(s): ${missing.map((x) => `${x.billId}:${x.lineId}`).join(', ')}`
        });
        return;
      }

      const tranId = invoice.getValue({ fieldId: 'tranid' });
      const tranDate = invoice.getValue({ fieldId: 'trandate' });
      const dateText = tranDate ? format.format({ value: tranDate, type: format.Type.DATE }) : '';
      const memo = `WIP relief - Invoice ${tranId} - Project ${projectId}`;
      const je = record.create({ type: record.Type.JOURNAL_ENTRY, isDynamic: true });

      je.setValue({ fieldId: 'subsidiary', value: subsidiary });
      if (tranDate) je.setValue({ fieldId: 'trandate', value: tranDate });
      je.setValue({ fieldId: 'memo', value: `${memo} - ${dateText}` });
      je.setValue({ fieldId: CFG.RELATED_JE, value: invoiceId });

      costs.forEach((line) => {
        const amount = Math.abs(line.amount);
        addLine(je, line.cogs, line.amount > 0 ? amount : 0, line.amount < 0 ? amount : 0, line, memo, projectId);
        addLine(je, CFG.WIP_ACCOUNT, line.amount < 0 ? amount : 0, line.amount > 0 ? amount : 0, line, memo, projectId);
      });

      const jeId = je.save({ enableSourcing: true, ignoreMandatoryFields: false });

      record.submitFields({
        type: record.Type.INVOICE,
        id: invoiceId,
        values: { [CFG.RELATED_JE]: jeId }
      });

      [...new Set(costs.map((line) => line.billId))].forEach((billId) => {
        try {
          record.submitFields({
            type: record.Type.VENDOR_BILL,
            id: billId,
            values: { [CFG.RELATED_JE]: jeId }
          });
        } catch (e) {
          log.error({ title: 'Bill link failed', details: `Bill ${billId}, JE ${jeId}: ${e.message}` });
        }
      });

      log.audit({
        title: 'WIP relief created',
        details: `Invoice ${invoiceId}, Project ${projectId}, JE ${jeId}, ${costs.length} Bill line(s).`
      });
    } catch (e) {
      log.error({ title: 'Invoice WIP relief failed', details: e.stack || e.message || e });
    }
  };

  const addLine = (je, account, debit, credit, source, memo, projectId) => {
    je.selectNewLine({ sublistId: 'line' });
    je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: account });
    if (debit) je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'debit', value: debit });
    if (credit) je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'credit', value: credit });
    je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'memo', value: memo });
    je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'entity', value: projectId });
    setLine(je, 'department', source.department);
    setLine(je, 'class', source.classId);
    setLine(je, 'location', source.location);
    setLine(je, CFG.CUSTOMER_TYPE, source.customerType);
    setLine(je, CFG.SERVICE_TYPE, source.serviceType);
    setLine(je, CFG.LINE_SOURCE, source.billId);
    setLine(je, CFG.LINE_SOURCE_ID, source.lineId);
    je.commitLine({ sublistId: 'line' });
  };

  const reverseJe = (jeId, memo, clearBills) => {
    const original = record.load({ type: record.Type.JOURNAL_ENTRY, id: jeId });
    const reversal = record.create({ type: record.Type.JOURNAL_ENTRY, isDynamic: true });
    const billIds = new Set();

    reversal.setValue({ fieldId: 'subsidiary', value: original.getValue({ fieldId: 'subsidiary' }) });
    reversal.setValue({ fieldId: 'trandate', value: new Date() });
    reversal.setValue({ fieldId: 'memo', value: `Reversal of JE ${jeId} - ${memo}` });

    for (let i = 0; i < original.getLineCount({ sublistId: 'line' }); i++) {
      const debit = Number(original.getSublistValue({ sublistId: 'line', fieldId: 'debit', line: i }) || 0);
      const credit = Number(original.getSublistValue({ sublistId: 'line', fieldId: 'credit', line: i }) || 0);
      const billId = original.getSublistValue({ sublistId: 'line', fieldId: CFG.LINE_SOURCE, line: i });
      if (billId) billIds.add(String(billId));

      reversal.selectNewLine({ sublistId: 'line' });
      reversal.setCurrentSublistValue({
        sublistId: 'line',
        fieldId: 'account',
        value: original.getSublistValue({ sublistId: 'line', fieldId: 'account', line: i })
      });
      if (credit) reversal.setCurrentSublistValue({ sublistId: 'line', fieldId: 'debit', value: round(credit) });
      if (debit) reversal.setCurrentSublistValue({ sublistId: 'line', fieldId: 'credit', value: round(debit) });

      ['department', 'class', 'location', CFG.CUSTOMER_TYPE, CFG.SERVICE_TYPE, CFG.LINE_SOURCE, CFG.LINE_SOURCE_ID]
        .forEach((fieldId) => {
          const value = original.getSublistValue({ sublistId: 'line', fieldId, line: i });
          setLine(reversal, fieldId, value);
        });

      setLine(reversal, 'entity', original.getSublistValue({ sublistId: 'line', fieldId: 'entity', line: i }));
      reversal.setCurrentSublistValue({ sublistId: 'line', fieldId: 'memo', value: `Reversal of JE ${jeId}` });
      reversal.commitLine({ sublistId: 'line' });
    }

    const reversalId = reversal.save({ enableSourcing: true, ignoreMandatoryFields: false });

    if (clearBills) {
      billIds.forEach((billId) => {
        const linked = search.lookupFields({
          type: search.Type.VENDOR_BILL,
          id: billId,
          columns: [CFG.RELATED_JE]
        })[CFG.RELATED_JE];
        const linkedId = Array.isArray(linked) && linked[0] ? String(linked[0].value) : '';
        if (linkedId === String(jeId)) {
          record.submitFields({
            type: record.Type.VENDOR_BILL,
            id: billId,
            values: { [CFG.RELATED_JE]: '' }
          });
        }
      });
    }

    log.audit({ title: 'WIP relief reversed', details: `JE ${jeId} reversed by JE ${reversalId}.` });
  };

  const setLine = (je, fieldId, value) => {
    if (value !== null && value !== undefined && value !== '') {
      je.setCurrentSublistValue({ sublistId: 'line', fieldId, value });
    }
  };

  const findSourceJe = (sourceId) => {
    let jeId = '';
    search.create({
      type: search.Type.JOURNAL_ENTRY,
      filters: [
        [CFG.RELATED_JE, 'anyof', sourceId], 'AND',
        ['isreversal', 'is', 'F'], 'AND',
        ['reversaldate', 'isempty', '']
      ],
      columns: ['internalid']
    }).run().each((result) => {
      jeId = result.id;
      return false;
    });
    return jeId;
  };

  const round = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

  return { afterSubmit };
});
