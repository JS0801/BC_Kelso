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
      const sourceJe = context.newRecord;
      const sourceJeId = sourceJe ? sourceJe.id : '';

      log.audit({
        title: 'Labor JE WIP relief entered',
        details: `Context type: ${context.type}, approve type: ${context.UserEventType.APPROVE}, JE: ${sourceJeId || 'blank'}`
      });

      // if (context.type !== context.UserEventType.APPROVE) {
      //   log.debug({
      //     title: 'Labor JE WIP relief skipped - event type',
      //     details: `JE ${sourceJeId || 'blank'} context type ${context.type} is not ${context.UserEventType.APPROVE}.`
      //   });
      //   return;
      // }

      const approvalStatus = String(sourceJe.getValue({ fieldId: 'approvalstatus' }) || '');

      log.debug({
        title: 'Labor JE WIP relief approval check',
        details: `JE ${sourceJeId}, approvalstatus ${approvalStatus || 'blank'}, required ${CFG.APPROVED}.`
      });

      if (approvalStatus !== CFG.APPROVED) {
        log.debug({
          title: 'Labor JE WIP relief skipped - approval status',
          details: `JE ${sourceJeId} approvalstatus ${approvalStatus || 'blank'} is not approved.`
        });
        return;
      }

      // Generated WIP relief JEs point back to their source JE. Do not process them again.
      const relatedSource = sourceJe.getValue({ fieldId: CFG.RELATED_JE });
      if (relatedSource) {
        log.audit({
          title: 'Labor JE WIP relief skipped - related transaction',
          details: `JE ${sourceJeId} already has ${CFG.RELATED_JE} = ${relatedSource}.`
        });
        return;
      }

      const subsidiary = sourceJe.getValue({ fieldId: 'subsidiary' });
      log.debug({
        title: 'Labor JE WIP relief subsidiary check',
        details: `JE ${sourceJeId}, subsidiary ${subsidiary || 'blank'}, allowed ${CFG.SUBSIDIARIES.join(', ')}.`
      });

      if (!CFG.SUBSIDIARIES.includes(String(subsidiary || ''))) {
        log.audit({
          title: 'Labor JE WIP relief skipped - subsidiary',
          details: `JE ${sourceJeId} subsidiary ${subsidiary || 'blank'} is not in allowed subsidiary list.`
        });
        return;
      }

      const lines = getWipLines(sourceJe);
      log.audit({
        title: 'Labor JE WIP relief WIP lines found',
        details: `JE ${sourceJeId}, WIP account ${CFG.WIP_ACCOUNT}, matching line count ${lines.length}.`
      });

      if (!lines.length) {
        log.audit({
          title: 'Labor JE WIP relief skipped - no WIP lines',
          details: `JE ${sourceJeId} has no non-zero ${CFG.WIP_ACCOUNT} lines.`
        });
        return;
      }

      const projectOffsetAccountById = getProjectOffsetAccountMap(lines);
      const projectIds = Object.keys(projectOffsetAccountById);
      const unmappedProjectIds = projectIds.filter((projectId) => !projectOffsetAccountById[projectId]);

      log.audit({
        title: 'Labor JE WIP relief project map summary',
        details: `JE ${sourceJeId}, unique projects ${projectIds.length}, mapped ${projectIds.length - unmappedProjectIds.length}, ` +
          `unmapped ${unmappedProjectIds.length}${unmappedProjectIds.length ? ` (${unmappedProjectIds.join(', ')})` : ''}.`
      });

      log.debug({
        title: 'Labor JE WIP relief project account map',
        details: JSON.stringify(projectOffsetAccountById)
      });

      const reliefLines = [];
      let skippedNoProject = 0;
      let skippedProjectLookup = 0;

      lines.forEach((line) => {
        if (!line.projectId) {
          skippedNoProject += 1;
          log.debug({
            title: 'Labor JE WIP relief skipped line - no project',
            details: `JE ${sourceJeId}, source line ${line.lineId || 'blank'}, amount ${line.amount}.`
          });
          return;
        }

        const offsetAccount = projectOffsetAccountById[String(line.projectId)];
        if (!offsetAccount) {
          skippedProjectLookup += 1;
          log.debug({
            title: 'Labor JE WIP relief skipped line - no offset account',
            details: `JE ${sourceJeId}, source line ${line.lineId || 'blank'}, project ${line.projectId}, amount ${line.amount}.`
          });
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

      log.audit({
        title: 'Labor JE WIP relief lines ready',
        details: `JE ${sourceJeId}, relief source lines ${reliefLines.length}, ` +
          `skipped without Project ${skippedNoProject}, skipped lookup ${skippedProjectLookup}.`
      });

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

        log.debug({
          title: 'Labor JE WIP relief adding lines',
          details: `JE ${sourceJeId}, source line ${line.lineId || 'blank'}, project ${line.projectId}, ` +
            `amount ${line.amount}, offset account ${line.offsetAccount}.`
        });

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

      log.audit({
        title: 'Labor JE WIP relief saving JE',
        details: `Source JE ${sourceJeId}, generated line count ${reliefLines.length * 2}.`
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

    log.debug({
      title: 'Labor JE WIP relief line scan started',
      details: `JE ${sourceJe.id}, total line count ${lineCount}.`
    });

    for (let i = 0; i < lineCount; i += 1) {
      const account = String(sourceJe.getSublistValue({ sublistId: 'line', fieldId: 'account', line: i }) || '');
      if (account !== CFG.WIP_ACCOUNT) {
        log.debug({
          title: 'Labor JE WIP relief line ignored - account',
          details: `JE ${sourceJe.id}, line ${i}, account ${account || 'blank'}.`
        });
        continue;
      }

      const debit = Number(sourceJe.getSublistValue({ sublistId: 'line', fieldId: 'debit', line: i }) || 0);
      const credit = Number(sourceJe.getSublistValue({ sublistId: 'line', fieldId: 'credit', line: i }) || 0);
      const amount = round(debit - credit);
      if (!amount) {
        log.debug({
          title: 'Labor JE WIP relief line ignored - zero amount',
          details: `JE ${sourceJe.id}, line ${i}, debit ${debit}, credit ${credit}.`
        });
        continue;
      }

      const lineData = {
        sourceLineIndex: i,
        amount,
        projectId: sourceJe.getSublistValue({ sublistId: 'line', fieldId: 'entity', line: i }),
        lineId: sourceJe.getSublistValue({ sublistId: 'line', fieldId: 'lineuniquekey', line: i }),
        memo: sourceJe.getSublistValue({ sublistId: 'line', fieldId: 'memo', line: i }),
        department: sourceJe.getSublistValue({ sublistId: 'line', fieldId: 'department', line: i }),
        classId: sourceJe.getSublistValue({ sublistId: 'line', fieldId: 'class', line: i }),
        location: sourceJe.getSublistValue({ sublistId: 'line', fieldId: 'location', line: i }),
        customerType: sourceJe.getSublistValue({ sublistId: 'line', fieldId: CFG.CUSTOMER_TYPE, line: i }),
        serviceType: sourceJe.getSublistValue({ sublistId: 'line', fieldId: CFG.SERVICE_TYPE, line: i })
      };

      log.debug({
        title: 'Labor JE WIP relief line captured',
        details: `JE ${sourceJe.id}, line ${i}, unique key ${lineData.lineId || 'blank'}, ` +
          `project ${lineData.projectId || 'blank'}, amount ${amount}.`
      });

      lines.push(lineData);
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

    log.debug({
      title: 'Labor JE WIP relief project map started',
      details: `Unique project IDs: ${projectIds.length ? projectIds.join(', ') : 'none'}.`
    });

    if (!projectIds.length) return projectOffsetAccountById;

    try {
      search.create({
        type: 'job',
        filters: [['internalid', 'anyof', projectIds]],
        columns: [CFG.PROJECT_MAINTENANCE]
      }).run().each((result) => {
        const projectId = String(result.id || '');
        const maintenanceValue = result.getValue({ name: CFG.PROJECT_MAINTENANCE });
        projectOffsetAccountById[projectId] = isChecked(maintenanceValue)
          ? CFG.MAINTENANCE_OFFSET_ACCOUNT
          : CFG.STANDARD_OFFSET_ACCOUNT;

        log.debug({
          title: 'Labor JE WIP relief project mapped',
          details: `Project ${projectId}, ${CFG.PROJECT_MAINTENANCE}=${maintenanceValue}, ` +
            `offset account ${projectOffsetAccountById[projectId]}.`
        });

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

    log.debug({
      title: 'Labor JE WIP relief line committed',
      details: `Source JE ${sourceJeId}, source line ${source.lineId || 'blank'}, account ${account}, ` +
        `debit ${debit || 0}, credit ${credit || 0}, project ${source.projectId}.`
    });
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
