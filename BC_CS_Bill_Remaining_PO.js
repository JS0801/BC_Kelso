/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 */
define(['N/currentRecord', 'N/url'], (currentRecord, url) => {

    const SUITELET_SCRIPT_ID = 'customscript_bc_sl_bill_remaining_po';
    const SUITELET_DEPLOYMENT_ID = 'customdeploy_bc_sl_bill_remaining_po';

    /**
     * Standard pageInit entry point.
     */
    function pageInit(context) {
        // No initialization required
    }

    /**
     * Redirects the user to the Suitelet that performs
     * the native PO -> Vendor Bill transform.
     */
    function billRemaining() {

        const rec = currentRecord.get();

        const poId = rec.getValue({
            fieldId: 'custpage_bill_remaining_poid'
        });

        if (!poId) {
            alert('Purchase Order internal ID was not found.');
            return;
        }

        const suiteletUrl = url.resolveScript({
            scriptId: SUITELET_SCRIPT_ID,
            deploymentId: SUITELET_DEPLOYMENT_ID,
            params: {
                poid: String(poId),
                billremaining: 'T'
            }
        });

        window.location.href = suiteletUrl;
    }

    return {
        pageInit: pageInit,
        billRemaining: billRemaining
    };

});