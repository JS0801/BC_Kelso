/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/search', 'N/record', 'N/format', 'N/log'], (search, record, format, log) => {

    const RECORDS = {
        PROJECT: 'customrecord_cseg_bc_project',
        BILLING_HISTORY: 'customrecord_bc_project_billing_history'
    };

    const FIELDS = {
        INVOICE_PROJECT: 'cseg_bc_project',
        PROJECT_BILL_DATE: 'custrecord_bill_date',
        HISTORY_PROJECT: 'custrecord_bc_bh_project',
        HISTORY_CYCLE_DATE: 'custrecord_bc_bh_cycle_date',
        HISTORY_CYCLE_KEY: 'custrecord_bc_bh_cycle_key',
        HISTORY_STATUS: 'custrecord_bc_bh_status',
        HISTORY_NO_BILL_REASON: 'custrecord_bc_bh_no_bill_reason',
        HISTORY_RELATED_INVOICES: 'custrecord_bc_bh_related_invoices',
        HISTORY_ACCOUNTING_NOTIFIED: 'custrecord_bc_bh_accounting_notified'
    };

    // Create the custom-list values in this order and verify these IDs.
    const STATUS = {
        NO_BILLING: '1',
        INVOICED: '2'
    };

    const buildCycleKey = (projectId, cycleDate) => {
        const month = String(cycleDate.getMonth() + 1).padStart(2, '0');
        return `${projectId}|${cycleDate.getFullYear()}-${month}`;
    };

    const getFieldText = (fieldValue) => {
        if (!fieldValue) return '';
        if (Array.isArray(fieldValue)) {
            return fieldValue.length ? fieldValue[0].text || fieldValue[0].value || '' : '';
        }
        if (typeof fieldValue === 'object') {
            return fieldValue.text || fieldValue.value || '';
        }
        return String(fieldValue);
    };

    const getProjectCycleDate = (projectId, transactionDate) => {
        const projectValues = search.lookupFields({
            type: RECORDS.PROJECT,
            id: projectId,
            columns: [FIELDS.PROJECT_BILL_DATE]
        });
        const billText = getFieldText(projectValues[FIELDS.PROJECT_BILL_DATE]);

        if (!billText) {
            throw new Error(`Project ${projectId} does not have a Bill Date.`);
        }

        const year = transactionDate.getFullYear();
        const month = transactionDate.getMonth();
        const lastDay = new Date(year, month + 1, 0).getDate();
        const day = String(billText).toUpperCase() === 'EOM'
            ? lastDay
            : Math.min(Number.parseInt(billText, 10), lastDay);

        return new Date(year, month, day);
    };

    const findHistory = (key) => {
        const results = search.create({
            type: RECORDS.BILLING_HISTORY,
            filters: [
                [FIELDS.HISTORY_CYCLE_KEY, 'is', key],
                'AND',
                ['isinactive', 'is', 'F']
            ],
            columns: ['internalid', FIELDS.HISTORY_STATUS]
        }).run().getRange({ start: 0, end: 2 }) || [];

        if (results.length > 1) {
            log.error('Duplicate Billing History records', {
                cycleKey: key,
                recordIds: results.map((result) => result.id)
            });
        }

        return results.length
            ? {
                id: results[0].id,
                status: String(
                    results[0].getValue({ name: FIELDS.HISTORY_STATUS }) || ''
                )
            }
            : null;
    };

    const findInvoiceIds = (projectId, transactionDate) => {
        const monthStart = new Date(
            transactionDate.getFullYear(),
            transactionDate.getMonth(),
            1
        );
        const monthEnd = new Date(
            transactionDate.getFullYear(),
            transactionDate.getMonth() + 1,
            0
        );
        const invoiceIds = [];

        search.create({
            type: 'invoice',
            filters: [
                ['mainline', 'is', 'T'],
                'AND',
                [FIELDS.INVOICE_PROJECT, 'anyof', projectId],
                'AND',
                ['trandate', 'within',
                    format.format({ value: monthStart, type: format.Type.DATE }),
                    format.format({ value: monthEnd, type: format.Type.DATE })]
            ],
            columns: ['internalid']
        }).run().each((result) => {
            invoiceIds.push(String(result.id));
            return true;
        });

        return invoiceIds;
    };

    const refreshHistory = (projectId, transactionDate) => {
        if (!projectId || !(transactionDate instanceof Date)) return;

        const cycleDate = getProjectCycleDate(projectId, transactionDate);
        const key = buildCycleKey(projectId, cycleDate);
        const invoiceIds = findInvoiceIds(projectId, transactionDate);
        const existing = findHistory(key);

        if (!invoiceIds.length) {
            if (existing && existing.status === STATUS.INVOICED) {
                record.delete({
                    type: RECORDS.BILLING_HISTORY,
                    id: existing.id
                });
                log.audit('Invoiced Billing History deleted - no invoices remain', {
                    historyId: existing.id,
                    projectId,
                    cycleKey: key
                });
            } else {
                log.debug('Billing History unchanged - no invoices remain', {
                    projectId,
                    cycleKey: key,
                    existingStatus: existing ? existing.status : '(none)'
                });
            }
            return;
        }

        const historyRecord = existing
            ? record.load({
                type: RECORDS.BILLING_HISTORY,
                id: existing.id,
                isDynamic: false
            })
            : record.create({
                type: RECORDS.BILLING_HISTORY,
                isDynamic: false
            });

        historyRecord.setValue({
            fieldId: 'name',
            value: `Project ${projectId} - ${key.split('|')[1]}`
        });
        historyRecord.setValue({
            fieldId: FIELDS.HISTORY_PROJECT,
            value: projectId
        });
        historyRecord.setValue({
            fieldId: FIELDS.HISTORY_CYCLE_DATE,
            value: cycleDate
        });
        historyRecord.setValue({
            fieldId: FIELDS.HISTORY_CYCLE_KEY,
            value: key
        });
        historyRecord.setValue({
            fieldId: FIELDS.HISTORY_STATUS,
            value: STATUS.INVOICED
        });
        historyRecord.setValue({
            fieldId: FIELDS.HISTORY_NO_BILL_REASON,
            value: ''
        });
        historyRecord.setValue({
            fieldId: FIELDS.HISTORY_RELATED_INVOICES,
            value: invoiceIds
        });
        historyRecord.setValue({
            fieldId: FIELDS.HISTORY_ACCOUNTING_NOTIFIED,
            value: false
        });

        const historyId = historyRecord.save({
            enableSourcing: false,
            ignoreMandatoryFields: false
        });

        log.audit('Invoice Billing History refreshed', {
            historyId,
            projectId,
            cycleDate,
            cycleKey: key,
            invoiceIds,
            convertedFromNoBilling:
                Boolean(existing && existing.status === STATUS.NO_BILLING)
        });
    };

    const readInvoiceContext = (invoiceRecord) => {
        if (!invoiceRecord) return null;

        return {
            projectId: invoiceRecord.getValue({ fieldId: FIELDS.INVOICE_PROJECT }),
            transactionDate: invoiceRecord.getValue({ fieldId: 'trandate' })
        };
    };

    const afterSubmit = (context) => {
        try {
            const isDelete = context.type === context.UserEventType.DELETE;
            const oldContext = readInvoiceContext(context.oldRecord);
            let newContext = null;

            if (!isDelete) {
                const invoiceRecord = record.load({
                    type: record.Type.INVOICE,
                    id: context.newRecord.id,
                    isDynamic: false
                });
                newContext = readInvoiceContext(invoiceRecord);
            }

            if (newContext && newContext.projectId && newContext.transactionDate) {
                refreshHistory(newContext.projectId, newContext.transactionDate);
            }

            if (oldContext && oldContext.projectId && oldContext.transactionDate) {
                const oldKey = `${oldContext.projectId}|${oldContext.transactionDate.getFullYear()}-${String(
                    oldContext.transactionDate.getMonth() + 1
                ).padStart(2, '0')}`;
                const newKey = newContext
                    ? `${newContext.projectId}|${newContext.transactionDate.getFullYear()}-${String(
                        newContext.transactionDate.getMonth() + 1
                    ).padStart(2, '0')}`
                    : '';

                if (oldKey !== newKey) {
                    refreshHistory(oldContext.projectId, oldContext.transactionDate);
                }
            }
        } catch (error) {
            log.error('Invoice Billing History update failed', {
                contextType: context.type,
                invoiceId: context.newRecord
                    ? context.newRecord.id
                    : context.oldRecord && context.oldRecord.id,
                name: error.name,
                message: error.message,
                stack: error.stack
            });
            throw error;
        }
    };

    return { afterSubmit };
});
