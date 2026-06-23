/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */
define(['N/record', 'N/search', 'N/log'], (record, search, log) => {

  const CFG = {
    WIP_ACCOUNT: '1806',
    MAINTENANCE_OFFSET_ACCOUNT: '1886',
    STANDARD_OFFSET_ACCOUNT: '1876',
    SUBSIDIARIES: ['39', '57', '11', '59', '6'],
    APPROVED: '2',
    PENDING_APPROVAL: '1',
    PROJECT_MAINTENANCE: 'custentity_bc_maintenance',
    RELATED_JE: 'custbody_bc_related_transaction',
    LINE_SOURCE: 'custcol_bc_related_transaction',
    LINE_SOURCE_ID: 'custcol_bc_related_tran_line_id',
    CUSTOMER_TYPE: 'cseg_kelso_custseg1',
    SERVICE_TYPE: 'cseg1'
  };

  const afterSubmit = (context) => {
    try {
      if (context.type !== context.UserEventType.APPROVE) return;

      const sourceJe = context.newRecord;
      const sourceJeId = sourceJe.id;
      const approvalStatus = String(sourceJe.getValue({ fieldId: 'approvalstatus' }) || '');

      if (approvalStatus !== CFG.APPROVED) return;

      // Generated WIP relief JEs point back to their source JE. Do not process them again.
      if (sourceJe.getValue({ fieldId: CFG.RELATED_JE })) return;

      const subsidiary = sourceJe.getValue({ fieldId: 'subsidiary' });
      if (!CFG.SUBSIDIARIES.includes(String(subsidiary || ''))) return;

      const lines = getWipLines(sourceJe);
      if (!lines.length) return;

      const projectOffsetAccountById = getProjectOffsetAccountMap(lines);
      const reliefLines = [];
      let skippedNoProject = 0;
      let skippedProjectLookup = 0;

      lines.forEach((line) => {
        if (!line.projectId) {
          skippedNoProject += 1;
          return;
        }

        const offsetAccount = projectOffsetAccountById[String(line.projectId)];
        if (!offsetAccount) {
          skippedProjectLookup += 1;
          return;
        }

        line.offsetAccount = offsetAccount;
        reliefLines.push(line);
      });

      if (!reliefLines.length) {
        log.audit({
          title: 'Labor JE WIP relief skipped',
          details: `JE ${sourceJeId} has WIP lines, but none had a usable line-level Project. ` +
            `Skipped without Project: ${skippedNoProject}. Skipped lookup failures: ${skippedProjectLookup}.`
        });
        return;
      }

      const tranId = sourceJe.getValue({ fieldId: 'tranid' }) || sourceJeId;
      const tranDate = sourceJe.getValue({ fieldId: 'trandate' });
      const memo = `WIP to COGS relief - Labor JE ${tranId}`;
      const reliefJe = record.create({ type: record.Type.JOURNAL_ENTRY, isDynamic: true });

      reliefJe.setValue({ fieldId: 'subsidiary', value: subsidiary });
      if (tranDate) reliefJe.setValue({ fieldId: 'trandate', value: tranDate });
      reliefJe.setValue({ fieldId: 'approvalstatus', value: CFG.PENDING_APPROVAL });
      reliefJe.setValue({ fieldId: 'memo', value: memo });
      reliefJe.setValue({ fieldId: CFG.RELATED_JE, value: sourceJeId });

      reliefLines.forEach((line) => {
        const amount = Math.abs(line.amount);

        addLine({
          je: reliefJe,
          account: line.offsetAccount,
          debit: line.amount > 0 ? amount : 0,
          credit: line.amount < 0 ? amount : 0,
          source: line,
          fallbackMemo: memo,
          sourceJeId
        });

        addLine({
          je: reliefJe,
          account: CFG.WIP_ACCOUNT,
          debit: line.amount < 0 ? amount : 0,
          credit: line.amount > 0 ? amount : 0,
          source: line,
          fallbackMemo: memo,
          sourceJeId
        });
      });

      const reliefJeId = reliefJe.save({ enableSourcing: true, ignoreMandatoryFields: false });

      log.audit({
        title: 'Labor JE WIP relief created',
        details: `Source JE ${sourceJeId}, relief JE ${reliefJeId}, ` +
          `${reliefLines.length} WIP line(s). Skipped without Project: ${skippedNoProject}. ` +
          `Skipped lookup failures: ${skippedProjectLookup}.`
      });
    } catch (e) {
      log.error({ title: 'Labor JE WIP relief failed', details: e.stack || e.message || e });
    }
  };

  const getWipLines = (sourceJe) => {
    const lines = [];
    const lineCount = sourceJe.getLineCount({ sublistId: 'line' });

    for (let i = 0; i < lineCount; i += 1) {
      const account = String(sourceJe.getSublistValue({ sublistId: 'line', fieldId: 'account', line: i }) || '');
      if (account !== CFG.WIP_ACCOUNT) continue;

      const debit = Number(sourceJe.getSublistValue({ sublistId: 'line', fieldId: 'debit', line: i }) || 0);
      const credit = Number(sourceJe.getSublistValue({ sublistId: 'line', fieldId: 'credit', line: i }) || 0);
      const amount = round(debit - credit);
      if (!amount) continue;

      lines.push({
        amount,
        projectId: sourceJe.getSublistValue({ sublistId: 'line', fieldId: 'entity', line: i }),
        lineId: sourceJe.getSublistValue({ sublistId: 'line', fieldId: 'lineuniquekey', line: i }),
        memo: sourceJe.getSublistValue({ sublistId: 'line', fieldId: 'memo', line: i }),
        department: sourceJe.getSublistValue({ sublistId: 'line', fieldId: 'department', line: i }),
        classId: sourceJe.getSublistValue({ sublistId: 'line', fieldId: 'class', line: i }),
        location: sourceJe.getSublistValue({ sublistId: 'line', fieldId: 'location', line: i }),
        customerType: sourceJe.getSublistValue({ sublistId: 'line', fieldId: CFG.CUSTOMER_TYPE, line: i }),
        serviceType: sourceJe.getSublistValue({ sublistId: 'line', fieldId: CFG.SERVICE_TYPE, line: i })
      });
    }

    return lines;
  };

  const getProjectOffsetAccountMap = (lines) => {
    const projectOffsetAccountById = {};
    const projectIds = [];

    lines.forEach((line) => {
      const projectId = String(line.projectId || '');
      if (!projectId || Object.prototype.hasOwnProperty.call(projectOffsetAccountById, projectId)) return;

      projectOffsetAccountById[projectId] = '';
      projectIds.push(projectId);
    });

    if (!projectIds.length) return projectOffsetAccountById;

    try {
      search.create({
        type: 'job',
        filters: [['internalid', 'anyof', projectIds]],
        columns: [CFG.PROJECT_MAINTENANCE]
      }).run().each((result) => {
        const projectId = String(result.id || '');
        projectOffsetAccountById[projectId] = isChecked(result.getValue({ name: CFG.PROJECT_MAINTENANCE }))
          ? CFG.MAINTENANCE_OFFSET_ACCOUNT
          : CFG.STANDARD_OFFSET_ACCOUNT;
        return true;
      });
    } catch (e) {
      log.error({
        title: 'Project maintenance map failed',
        details: e.stack || e.message || e
      });
    }

    return projectOffsetAccountById;
  };

  const addLine = ({ je, account, debit, credit, source, fallbackMemo, sourceJeId }) => {
    je.selectNewLine({ sublistId: 'line' });
    je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: account });
    if (debit) je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'debit', value: round(debit) });
    if (credit) je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'credit', value: round(credit) });
    je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'memo', value: source.memo || fallbackMemo });
    je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'entity', value: source.projectId });
    setLine(je, 'department', source.department);
    setLine(je, 'class', source.classId);
    setLine(je, 'location', source.location);
    setLine(je, CFG.CUSTOMER_TYPE, source.customerType);
    setLine(je, CFG.SERVICE_TYPE, source.serviceType);
    setLine(je, CFG.LINE_SOURCE, sourceJeId);
    setLine(je, CFG.LINE_SOURCE_ID, source.lineId);
    je.commitLine({ sublistId: 'line' });
  };

  const setLine = (je, fieldId, value) => {
    if (value !== null && value !== undefined && value !== '') {
      je.setCurrentSublistValue({ sublistId: 'line', fieldId, value });
    }
  };

  const isChecked = (value) => value === true || value === 'T' || value === 'true';

  const round = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

  return { afterSubmit };
});
