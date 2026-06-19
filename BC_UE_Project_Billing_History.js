/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/search', 'N/error', 'N/log'], (search, error, log) => {

    const RECORD_TYPE = 'customrecord_bc_project_billing_history';
    const PROJECT_RECORD_TYPE = 'customrecord_cseg_bc_project';

    const FIELDS = {
        PROJECT: 'custrecord_bc_bh_project',
        PROJECT_BILL_DATE: 'custrecord_bill_date',
        CYCLE_DATE: 'custrecord_bc_bh_cycle_date',
        CYCLE_KEY: 'custrecord_bc_bh_cycle_key',
        STATUS: 'custrecord_bc_bh_status',
        NO_BILL_REASON: 'custrecord_bc_bh_no_bill_reason',
        RELATED_INVOICES: 'custrecord_bc_bh_related_invoices',
        ACCOUNTING_NOTIFIED: 'custrecord_bc_bh_accounting_notified'
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

    const normalizeCycleDate = (projectId, selectedDate) => {
        const projectValues = search.lookupFields({
            type: PROJECT_RECORD_TYPE,
            id: projectId,
            columns: [FIELDS.PROJECT_BILL_DATE]
        });
        const billText = getFieldText(projectValues[FIELDS.PROJECT_BILL_DATE]);

        if (!billText) {
            throw error.create({
                name: 'BC_PROJECT_BILL_DATE_REQUIRED',
                message: 'The selected project must have a Bill Date.'
            });
        }

        const year = selectedDate.getFullYear();
        const month = selectedDate.getMonth();
        const lastDay = new Date(year, month + 1, 0).getDate();
        const day = String(billText).toUpperCase() === 'EOM'
            ? lastDay
            : Math.min(Number.parseInt(billText, 10), lastDay);

        return new Date(year, month, day);
    };

    const beforeSubmit = (context) => {
        const historyRecord = context.newRecord;

        if (context.type === context.UserEventType.XEDIT) {
            const changedFields = historyRecord.getFields().filter((fieldId) => {
                return fieldId !== 'id' && fieldId !== 'internalid';
            });
            const notificationOnly = changedFields.length > 0 &&
                changedFields.every((fieldId) => {
                    return fieldId === FIELDS.ACCOUNTING_NOTIFIED;
                });

            if (notificationOnly) {
                log.debug('Accounting notification flag update allowed', {
                    recordId: historyRecord.id,
                    changedFields
                });
                return;
            }

            throw error.create({
                name: 'BC_BILLING_HISTORY_INLINE_EDIT',
                message: 'Edit Billing History using the full record form, not inline editing.'
            });
        }

        const projectId = historyRecord.getValue({ fieldId: FIELDS.PROJECT });
        const selectedCycleDate = historyRecord.getValue({ fieldId: FIELDS.CYCLE_DATE });
        const status = String(historyRecord.getValue({ fieldId: FIELDS.STATUS }) || '');

        if (!projectId || !(selectedCycleDate instanceof Date) || !status) {
            throw error.create({
                name: 'BC_BILLING_HISTORY_REQUIRED',
                message: 'Project, Billing Cycle Date, and Status are required.'
            });
        }

        const cycleDate = normalizeCycleDate(projectId, selectedCycleDate);
        const key = buildCycleKey(projectId, cycleDate);
        const duplicateFilters = [
            [FIELDS.CYCLE_KEY, 'is', key],
            'AND',
            ['isinactive', 'is', 'F']
        ];

        if (historyRecord.id) {
            duplicateFilters.push('AND', ['internalid', 'noneof', historyRecord.id]);
        }

        const duplicateCount = search.create({
            type: RECORD_TYPE,
            filters: duplicateFilters,
            columns: ['internalid']
        }).runPaged().count;

        if (duplicateCount > 0) {
            throw error.create({
                name: 'BC_DUPLICATE_BILLING_CYCLE',
                message: `A Billing History record already exists for cycle ${key}.`
            });
        }

        historyRecord.setValue({
            fieldId: FIELDS.CYCLE_DATE,
            value: cycleDate
        });
        historyRecord.setValue({
            fieldId: FIELDS.CYCLE_KEY,
            value: key
        });
        historyRecord.setValue({
            fieldId: 'name',
            value: `Project ${projectId} - ${key.split('|')[1]}`
        });

        if (status === STATUS.NO_BILLING) {
            const reason = String(
                historyRecord.getValue({ fieldId: FIELDS.NO_BILL_REASON }) || ''
            ).trim();

            if (!reason) {
                throw error.create({
                    name: 'BC_NO_BILL_REASON_REQUIRED',
                    message: 'No Billing Reason is required when Status is No Billing.'
                });
            }

            historyRecord.setValue({
                fieldId: FIELDS.RELATED_INVOICES,
                value: []
            });

            const previousStatus = context.oldRecord
                ? String(context.oldRecord.getValue({ fieldId: FIELDS.STATUS }) || '')
                : '';
            if (context.type === context.UserEventType.CREATE ||
                previousStatus !== STATUS.NO_BILLING) {
                historyRecord.setValue({
                    fieldId: FIELDS.ACCOUNTING_NOTIFIED,
                    value: false
                });
            }
        }

        if (status === STATUS.INVOICED) {
            historyRecord.setValue({
                fieldId: FIELDS.NO_BILL_REASON,
                value: ''
            });
        }

        log.audit('Billing History validated', {
            recordId: historyRecord.id || '(new)',
            projectId,
            cycleDate,
            cycleKey: key,
            status
        });
    };

    return { beforeSubmit };
});
