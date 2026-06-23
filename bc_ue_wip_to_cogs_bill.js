/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */
define(['N/record', 'N/search', 'N/log', 'N/workflow'], (record, search, log, workflow) => {

  const CFG = {
    WIP_ACCOUNT: '1806',
    SUBSIDIARIES: ['39', '57', '11', '59', '6'],
    APPROVED: '2',
    CLOSED_STATUS: '1',
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
        if (jeId) reverseJe(jeId, `Bill ${context.oldRecord.id} deleted`);
        return;
      }

      if (context.type !== context.UserEventType.CREATE &&
          context.type !== context.UserEventType.EDIT &&
          context.type !== context.UserEventType.APPROVE) return;

      const bill = context.newRecord;
      const newStatus = String(bill.getValue({ fieldId: 'approvalstatus' }) || '');
      const oldStatus = context.oldRecord
        ? String(context.oldRecord.getValue({ fieldId: 'approvalstatus' }) || '')
        : '';

      // if (newStatus !== CFG.APPROVED) return;
      // if (context.type !== context.UserEventType.APPROVE && oldStatus === CFG.APPROVED) return;

      const billId = bill.id;
      const subsidiary = String(bill.getValue({ fieldId: 'subsidiary' }) || '');
     // if (findSourceJe(billId) || !CFG.SUBSIDIARIES.includes(subsidiary)) return;

      const costs = [];
      const billSearch = search.create({
        type: search.Type.VENDOR_BILL,
        settings: [{ name: 'consolidationtype', value: 'ACCTTYPE' }],
        filters: [
          ['internalid', 'anyof', billId], 'AND',
          ['account', 'anyof', CFG.WIP_ACCOUNT], 'AND',
          ['posting', 'is', 'T']
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
          search.createColumn({ name: CFG.ITEM_COGS, join: 'item' }),
          search.createColumn({ name: 'internalid', join: 'job' })
        ]
      });

      const pages = billSearch.runPaged({ pageSize: 1000 });
      pages.pageRanges.forEach((page) => {
        pages.fetch({ index: page.index }).data.forEach((result) => {
          const amount = round(
            Number(result.getValue({ name: 'debitamount' }) || 0) -
            Number(result.getValue({ name: 'creditamount' }) || 0)
          );

          if (!amount) return;
          costs.push({
            projectId: result.getValue({ name: 'internalid', join: 'job' }),
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

      if (!costs.length) return;

      const projectIds = [...new Set(costs.map((line) => String(line.projectId || '')).filter(Boolean))];
      if (!projectIds.length || costs.some((line) => !line.projectId)) {
        log.audit({ title: 'Bill WIP relief skipped', details: `Bill ${billId} has a WIP line without a Project.` });
        return;
      }

      for (const projectId of projectIds) {
        const status = search.lookupFields({
          type: 'job',
          id: projectId,
          columns: ['entitystatus']
        }).entitystatus;
        const statusId = Array.isArray(status) && status[0]
          ? String(status[0].value || '')
          : String((status && status.value) || status || '');

        if (statusId !== CFG.CLOSED_STATUS) {
          log.audit({
            title: 'Bill WIP relief skipped',
            details: `Bill ${billId}, Project ${projectId}, status ${statusId || 'blank'} is not closed.`
          });
          return;
        }
      }

      const missing = costs.filter((line) => !line.cogs);
      if (missing.length) {
        log.error({
          title: 'Bill WIP relief not created',
          details: `Bill ${billId} has ${missing.length} WIP line(s) without an Item COGS mapping.`
        });
        return;
      }

      const tranId = bill.getValue({ fieldId: 'tranid' });
      const tranDate = bill.getValue({ fieldId: 'trandate' });
      const memo = `Late WIP relief - Bill ${tranId}`;
      const je = record.create({ type: record.Type.JOURNAL_ENTRY, isDynamic: true });

      je.setValue({ fieldId: 'subsidiary', value: subsidiary });
      if (tranDate) je.setValue({ fieldId: 'trandate', value: tranDate });
      je.setValue({ fieldId: 'approvalstatus', value: 1 });
      je.setValue({ fieldId: 'memo', value: memo });
      je.setValue({ fieldId: CFG.RELATED_JE, value: billId });

      costs.forEach((line) => {
        const amount = Math.abs(line.amount);
        addLine(je, line.cogs, line.amount > 0 ? amount : 0, line.amount < 0 ? amount : 0, line, memo, billId);
        addLine(je, CFG.WIP_ACCOUNT, line.amount < 0 ? amount : 0, line.amount > 0 ? amount : 0, line, memo, billId);
      });

      const jeId = je.save({ ignoreMandatoryFields: false });
    //   workflow.initiate({
    //     recordType: record.Type.JOURNAL_ENTRY,
    //     recordId: jeId,
    //     workflowId: 'customworkflow_jouranl_approval'
    // });

      record.submitFields({
        type: record.Type.VENDOR_BILL,
        id: billId,
        values: { [CFG.RELATED_JE]: jeId }
      });

      log.audit({
        title: 'Late Bill WIP relief created',
        details: `Bill ${billId}, JE ${jeId}, Project(s) ${projectIds.join(', ')}, ${costs.length} WIP line(s).`
      });
    } catch (e) {
      log.error({ title: 'Bill WIP relief failed', details: e.stack || e.message || e });
    }
  };

  const addLine = (je, account, debit, credit, source, memo, billId) => {
    je.selectNewLine({ sublistId: 'line' });
    je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: account });
    if (debit) je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'debit', value: debit });
    if (credit) je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'credit', value: credit });
    je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'memo', value: memo });
    je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'entity', value: source.projectId });
    setLine(je, 'department', source.department);
    setLine(je, 'class', source.classId);
    setLine(je, 'location', source.location);
    setLine(je, CFG.CUSTOMER_TYPE, source.customerType);
    setLine(je, CFG.SERVICE_TYPE, source.serviceType);
    setLine(je, CFG.LINE_SOURCE, billId);
    setLine(je, CFG.LINE_SOURCE_ID, source.lineId);
    je.commitLine({ sublistId: 'line' });
  };

  const reverseJe = (jeId, memo) => {
    const original = record.load({ type: record.Type.JOURNAL_ENTRY, id: jeId });
    const reversal = record.create({ type: record.Type.JOURNAL_ENTRY, isDynamic: true });

    reversal.setValue({ fieldId: 'subsidiary', value: original.getValue({ fieldId: 'subsidiary' }) });
    reversal.setValue({ fieldId: 'trandate', value: new Date() });
    reversal.setValue({ fieldId: 'memo', value: `Reversal of JE ${jeId} - ${memo}` });

    for (let i = 0; i < original.getLineCount({ sublistId: 'line' }); i++) {
      const debit = Number(original.getSublistValue({ sublistId: 'line', fieldId: 'debit', line: i }) || 0);
      const credit = Number(original.getSublistValue({ sublistId: 'line', fieldId: 'credit', line: i }) || 0);

      reversal.selectNewLine({ sublistId: 'line' });
      reversal.setCurrentSublistValue({
        sublistId: 'line',
        fieldId: 'account',
        value: original.getSublistValue({ sublistId: 'line', fieldId: 'account', line: i })
      });
      if (credit) reversal.setCurrentSublistValue({ sublistId: 'line', fieldId: 'debit', value: round(credit) });
      if (debit) reversal.setCurrentSublistValue({ sublistId: 'line', fieldId: 'credit', value: round(debit) });

      ['entity', 'department', 'class', 'location', CFG.CUSTOMER_TYPE, CFG.SERVICE_TYPE, CFG.LINE_SOURCE, CFG.LINE_SOURCE_ID]
        .forEach((fieldId) => {
          const value = original.getSublistValue({ sublistId: 'line', fieldId, line: i });
          setLine(reversal, fieldId, value);
        });

      reversal.setCurrentSublistValue({ sublistId: 'line', fieldId: 'memo', value: `Reversal of JE ${jeId}` });
      reversal.commitLine({ sublistId: 'line' });
    }

    const reversalId = reversal.save({ enableSourcing: true, ignoreMandatoryFields: false });
    log.audit({ title: 'Late Bill WIP relief reversed', details: `JE ${jeId} reversed by JE ${reversalId}.` });
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
