/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(['N/redirect', 'N/record', 'N/runtime'],
    (redirect, record, runtime) => {

        /**
         * Opens the native PO -> Vendor Bill transform.
         */
        function onRequest(context) {

            try {

                const request = context.request;

                const poIdParam = request.parameters.poid;
                const billRemaining = request.parameters.billremaining;

                if (!poIdParam) {
                    throw new Error('Missing Purchase Order internal ID.');
                }

                const poId = parseInt(poIdParam, 10);
                if (!Number.isInteger(poId) || poId <= 0) {
                    throw new Error('Invalid Purchase Order internal ID.');
                }
                

                redirect.toRecordTransform({
                    fromType: record.Type.PURCHASE_ORDER,
                    fromId: poId,
                    toType: record.Type.VENDOR_BILL,
                    isEditMode: true,
                    parameters: {
                        custparam_bill_remaining: billRemaining === 'T' ? 'T' : 'F',
                        custparam_poid: String(poId)
                    }
                });

            } catch (e) {
                log.error({
                    title: 'Bill Remaining Suitelet Error', details: e
                });
                throw e;
            }
        }

        return {
            onRequest: onRequest
        };
    });