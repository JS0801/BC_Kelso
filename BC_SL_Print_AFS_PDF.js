/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(['N/file', 'N/log', 'N/render', 'N/runtime'], (file, log, render, runtime) => {
    const PARAM_XML_FILE_ID = 'custscript_kelso_afs_xml_file_id';

    function onRequest(context) {
        try {
            const request = context.request;
            const invoiceId = request.parameters.recordId || request.parameters.invoiceId || request.parameters.id || '';
            const xmlFileId = getXmlFileId(request);

            if (!xmlFileId) {
                throw new Error('Missing XML template file id. Set script parameter ' + PARAM_XML_FILE_ID + '.');
            }

            const templateXml = file.load({ id: xmlFileId }).getContents();
            const xmlString = buildXml(templateXml, getBlankValues());
            const pdfFile = render.xmlToPdf({ xmlString });

            pdfFile.name = 'Kelso_AFS_Forms_' + (invoiceId || 'Blank') + '.pdf';

            context.response.writeFile({
                file: pdfFile,
                isInline: true
            });
        } catch (error) {
            log.error({
                title: 'Kelso AFS Forms render failed',
                details: error
            });

            context.response.write({
                output: 'Unable to render Kelso AFS Forms: ' + escapeXml(String(error.message || error))
            });
        }
    }

    function getXmlFileId(request) {
        return runtime.getCurrentScript().getParameter({ name: PARAM_XML_FILE_ID }) ||
            request.parameters.xmlFileId ||
            request.parameters.xmlfileid ||
            '';
    }

    function buildXml(templateXml, values) {
        const mergedXml = templateXml.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => {
            return escapeXml(values[key] || '');
        });

        return stripEmptyImages(mergedXml);
    }

    function stripEmptyImages(xmlString) {
        return xmlString
            .replace(/<img\b([^>]*?)\bsrc=(["'])\s*\2([^>]*?)\/>/gi, '')
            .replace(/<img\b([^>]*?)\bsrc=(["'])\s*\2([^>]*?)>\s*<\/img>/gi, '');
    }

    function getBlankValues() {
        return {
            AFS_AMOUNT_1: '',
            AFS_AMOUNT_2: '',
            AFS_AMOUNT_3: '',
            AFS_DESC_1: '',
            AFS_DESC_2: '',
            AFS_DESC_3: '',
            AFS_ISSUE_COMPANY_NAME: '',
            AFS_ISSUE_DATE: '',
            AFS_ISSUE_PROJECT: '',
            AFS_ISSUE_SIGNATURE: '',
            AFS_ISSUE_THROUGH_DATE: '',
            AFS_LOGO_URL: '',
            AFS_NO_ISSUE_COMPANY_NAME: '',
            AFS_NO_ISSUE_DATE: '',
            AFS_NO_ISSUE_PROJECT: '',
            AFS_NO_ISSUE_SIGNATURE: '',
            AFS_NO_ISSUE_THROUGH_DATE: '',
            NOTARY_COMMISSION_EXPIRES: '',
            NOTARY_DAY: '',
            NOTARY_ID_TYPE: '',
            NOTARY_MONTH: '',
            NOTARY_PERSON_NAME: '',
            NOTARY_PERSON_TITLE: '',
            NOTARY_PRINTED_NAME: '',
            NOTARY_YEAR: '',
            WAIVER_APPLICATION_DATE: '',
            WAIVER_COUNTY: '',
            WAIVER_DATE: '',
            WAIVER_PAYMENT_AMOUNT: '',
            WAIVER_PRINT_NAME: '',
            WAIVER_PROPERTY_ADDRESS: '',
            WAIVER_SIGNED_BY: '',
            WAIVER_SUBCONTRACTOR: '',
            WAIVER_TITLE: ''
        };
    }

    function escapeXml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    return { onRequest };
});
