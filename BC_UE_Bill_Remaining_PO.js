/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/runtime'],
    (runtime) => {

        /**
         * Adds the "Bill Remaining" button to the Purchase Order form
         * and attaches the client script.
         */
        function beforeLoad(context) {

            if (context.type !== context.UserEventType.VIEW) {
                return;
            }

            const form = context.form;
            const poRecord = context.newRecord;

            const subsidiaryId = poRecord.getValue({
                fieldId: 'subsidiary'
            });
            const MULLINS_SUBSIDIARY_ID = runtime.getCurrentScript().getParameter({name: 'custscript_bc_ue_billremaining_sub'});
            if (String(subsidiaryId) !== String(MULLINS_SUBSIDIARY_ID)) {
                return;
            }


            const poId = poRecord.id;
            if (!poId) {
                return;
            }

            const hiddenField = form.addField({
                id: 'custpage_bill_remaining_poid',
                type: 'text',
                label: 'PO Internal ID'
            });

            hiddenField.updateDisplayType({
                displayType: 'hidden'
            });

            hiddenField.defaultValue = String(poId);

            form.clientScriptModulePath = '../client_script/BC_CS_Bill_Remaining_PO.js';

            form.addButton({
                id: 'custpage_bill_remaining',
                label: 'Bill Remaining',
                functionName: 'billRemaining'
            });
        }

        return {
            beforeLoad: beforeLoad
        };

    });