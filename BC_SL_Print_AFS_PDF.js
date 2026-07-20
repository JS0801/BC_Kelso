/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(['N/file', 'N/log', 'N/render', 'N/runtime', 'N/search'], (file, log, render, runtime, search) => {
    const PARAM_XML_FILE_ID = 'custscript_kelso_afs_xml_file_id';

    function onRequest(context) {
        try {
            const request = context.request;
            const invoiceId = request.parameters.id || '';
            const xmlFileId = getXmlFileId(request);

            if (!xmlFileId) {
                throw new Error('Missing XML template file id. Set script parameter ' + PARAM_XML_FILE_ID + '.');
            }

            const templateXml = file.load({ id: xmlFileId }).getContents();
            const xmlString = buildXml(templateXml, getBlankValues(invoiceId));
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

  function fixedUnderlineValue(value, totalLength) {
    var text = String(value || '');
    var remaining = Math.max(totalLength - text.length, 0);
    return text + '\u00A0'.repeat(remaining);
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

    function getBlankValues(invoiceId) {

      var openAR = false;
      var projectName = null;
      var dateInv = null;
      var InvAmount = null;

const invoiceSearchObj = search.create({
   type: "invoice",
   settings:[{"name":"consolidationtype","value":"ACCTTYPE"}],
   filters:
   [
      ["internalid","anyof",invoiceId], 
      "AND", 
      ["mainline","is","T"],
      "AND",
      ["cseg_bc_project", "noneof", "@NONE@"]
   ],
   columns:
   [
      search.createColumn({name: "total", label: "Amount (Transaction Total)"}),
      search.createColumn({name: "trandate", label: "Date"}),
      search.createColumn({name: "cseg_bc_project", label: "Blue Collar Project"})
   ]
});
const searchResultCount = invoiceSearchObj.runPaged().count;
log.debug("invoiceSearchObj result count",searchResultCount);
invoiceSearchObj.run().each(function(result){
   var projId = result.getValue({name: "cseg_bc_project"});
   projectName = result.getText({name: "cseg_bc_project"});
   dateInv = result.getValue({name: "trandate"});
   InvAmount = result.getValue({name: "total"});



const invoiceSearchObj1 = search.create({
   type: "invoice",
   settings:[{"name":"consolidationtype","value":"ACCTTYPE"}],
   filters:
   [
      ["mainline","is","T"], 
      "AND", 
      ["posting","is","T"], 
      "AND", 
      ["cseg_bc_project","anyof", projId], 
      "AND", 
      ["amountremainingisabovezero","is","T"]
   ],
   columns:
   [
      search.createColumn({name: "internalid"})
   ]
});
const searchResultCount1 = invoiceSearchObj1.runPaged().count;
log.debug("invoiceSearchObj result count",searchResultCount1);

  if (searchResultCount1 > 0) openAR = true;
  
   return true;
});

      var dateObj = getCurrentDateDetails();

      if (openAR) {
        var finObj = {
          AFS_ISSUE_COMPANY_NAME: 'Premier Electric Opco, LLC',
          AFS_ISSUE_DATE: dateObj.currentDate,
          AFS_ISSUE_PROJECT: projectName,
          AFS_ISSUE_THROUGH_DATE: dateObj.currentDate,
          AFS_NO_ISSUE_PROJECT: fixedUnderlineValue('', 35),
          AFS_NO_ISSUE_THROUGH_DATE: fixedUnderlineValue('', 18),
          AFS_ISSUE_PROJECT: fixedUnderlineValue(projectName, 35),
          AFS_ISSUE_THROUGH_DATE: fixedUnderlineValue(dateObj.currentDate, 18)
        }
      }else {
        var finObj = {
          AFS_NO_ISSUE_COMPANY_NAME: 'Premier Electric Opco, LLC',
          AFS_NO_ISSUE_DATE: dateObj.currentDate,
          AFS_NO_ISSUE_PROJECT: projectName,
          AFS_NO_ISSUE_THROUGH_DATE: dateObj.currentDate,
          AFS_NO_ISSUE_PROJECT: fixedUnderlineValue(projectName, 35),
          AFS_NO_ISSUE_THROUGH_DATE: fixedUnderlineValue(dateObj.currentDate, 18),
          AFS_ISSUE_PROJECT: fixedUnderlineValue('', 35),
          AFS_ISSUE_THROUGH_DATE: fixedUnderlineValue('', 18)
        }
      }
      
        return {
            AFS_AMOUNT_1: '',
            AFS_AMOUNT_2: '',
            AFS_AMOUNT_3: '',
            AFS_DESC_1: '',
            AFS_DESC_2: '',
            AFS_DESC_3: '',
            AFS_ISSUE_COMPANY_NAME: finObj.AFS_ISSUE_COMPANY_NAME,
            AFS_ISSUE_DATE: finObj.AFS_ISSUE_DATE,
            AFS_ISSUE_PROJECT: finObj.AFS_ISSUE_PROJECT,
            AFS_ISSUE_SIGNATURE: finObj.AFS_ISSUE_SIGNATURE,
            AFS_ISSUE_THROUGH_DATE: finObj.AFS_ISSUE_THROUGH_DATE,
            AFS_NO_ISSUE_COMPANY_NAME: finObj.AFS_NO_ISSUE_COMPANY_NAME,
            AFS_NO_ISSUE_DATE: finObj.AFS_NO_ISSUE_DATE,
            AFS_NO_ISSUE_PROJECT: finObj.AFS_NO_ISSUE_PROJECT,
            AFS_NO_ISSUE_SIGNATURE: finObj.AFS_NO_ISSUE_THROUGH_DATE,
            AFS_NO_ISSUE_THROUGH_DATE: finObj.AFS_NO_ISSUE_THROUGH_DATE,
            NOTARY_COMMISSION_EXPIRES: '',
            NOTARY_DAY: dateObj.day,
            NOTARY_ID_TYPE: '',
            NOTARY_MONTH: dateObj.month,
            NOTARY_PERSON_NAME: 'Robert Forbis / Eric Perez',
            NOTARY_PERSON_TITLE: 'President',
            NOTARY_YEAR: dateObj.year,
            WAIVER_APPLICATION_DATE: dateInv,
            WAIVER_COUNTY: 'COLLIER',
            WAIVER_DATE: dateObj.currentDate,
            WAIVER_PAYMENT_AMOUNT: InvAmount,
            WAIVER_PRINT_NAME: 'Robert Forbis / Eric Perez',
            WAIVER_PROPERTY_ADDRESS: projectName,
            WAIVER_SIGNED_BY: '',
            WAIVER_SUBCONTRACTOR: 'Premier Electric Opco, LLC',
            WAIVER_TITLE: 'President'
        };
    }


function getCurrentDateDetails() {
    var today = new Date();

    var monthNames = [
        "January", "February", "March", "April",
        "May", "June", "July", "August",
        "September", "October", "November", "December"
    ];

    var day = today.getDate();
    var suffix = "th";

    if (day % 10 === 1 && day !== 11) {
        suffix = "st";
    } else if (day % 10 === 2 && day !== 12) {
        suffix = "nd";
    } else if (day % 10 === 3 && day !== 13) {
        suffix = "rd";
    }

    var mm = String(today.getMonth() + 1).padStart(2, "0");
    var dd = String(day).padStart(2, "0");
    var yyyy = today.getFullYear();

    return {
        currentDate: mm + "/" + dd + "/" + yyyy,
        day: day + suffix,
        month: monthNames[today.getMonth()],
        year: String(yyyy)
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
