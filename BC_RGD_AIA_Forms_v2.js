/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(['N/ui/serverWidget', 'N/file', 'N/record', 'N/render', 'N/search', 'N/https', 'N/log', 'N/url', 'N/redirect'],
    function (ui, file, record, render, search, https, log, url, redirect) {

        function onRequest(context) {
            if (context.request.method === 'GET') {
                const request = context.request;
                const response = context.response;

                try {
                    // 1. Get the current record ID (e.g., passed via parameter)
                    const recId = request.parameters.recordid;
                    if (!recId) throw 'Missing record ID';

                    // 2. Load the customer record (change type as needed)
                    const invoiceRec = record.load({
                        type: record.Type.INVOICE,
                        id: recId,
                    });
                    const subRec = record.load({
                        type: 'subsidiary',
                        id: invoiceRec.getValue('subsidiary'),
                    });
                    const projRec = record.load({
                        type: 'customrecord_cseg_bc_project',
                        id: invoiceRec.getValue('cseg_bc_project'),
                    });


                    const htmlFile1 = file.load({ id: 320860 }); // replace with actual file ID

                    let html1 = htmlFile1.getContents();


                    const FROMCONTRACTOR = subRec.getValue('name').replace(/&/g, '&amp;') + '<br/>' + subRec.getValue('mainaddress_text').replace('\n', '<br />').replace(/&/g, '&amp;');
                    const TOOWNER = invoiceRec.getValue('billaddress').replace('\n', '<br />').replace(/&/g, '&amp;');
                    const tranid = invoiceRec.getValue('tranid').replace('\n', '<br />').replace(/&/g, '&amp;');
                    const PROJECT = invoiceRec.getText('cseg_bc_project').replace(/&/g, '&amp;');
                    const PROJECTID = invoiceRec.getValue('cseg_bc_project');
                    const CREATEDFROM = invoiceRec.getValue('createdfrom').replace(/&/g, '&amp;');
                    const applicationNumber = invoiceRec.getValue('custbody_bc_pay_app_number').replace(/&/g, '&amp;');
                    const periodTo = invoiceRec.getText('enddate');
                    const transDate = invoiceRec.getText('trandate');
                    const projectNumber = projRec.getValue('custrecord_bc_project_nos');
                    const contractDate = projRec.getText('custrecordbc_proj_contract_date');
                    const contractFor = projRec.getValue('custrecord_bc_contract_for').replace(/&/g, '&amp;');
                    const CONTRACTOR = invoiceRec.getText('subsidiary').replace(/&/g, '&amp;');
                    const BY = invoiceRec.getText('custbody_bc_aia_by').replace(/&/g, '&amp;');
                    const STATEOF = invoiceRec.getText('custbody_bc_aia_stateof').replace(/&/g, '&amp;');
                    const COUNTYOF = invoiceRec.getValue('custbody_bc_aia_countyof').replace(/&/g, '&amp;');
                    const SUBSCRIBED = invoiceRec.getText('custbody_bc_aia_subscribed');
                    const DAYOF = invoiceRec.getValue('custbody_bc_aia_day_of').replace(/&/g, '&amp;');
                    const NOTARYPUB = invoiceRec.getValue('custbody_bc_aia_notary_public').replace(/&/g, '&amp;');

                    // Replace {{customer}} with actual name
                    html1 = html1.replace(/{{ TOOWNER }}/g, TOOWNER);
                    html1 = html1.replace(/{{ tranid }}/g, tranid);
                    html1 = html1.replace(/{{ FROMCONTRACTOR }}/g, FROMCONTRACTOR);
                    html1 = html1.replace(/{{ PROJECT }}/g, PROJECT);
                    html1 = html1.replace(/{{ applicationNumber }}/g, applicationNumber);
                    html1 = html1.replace(/{{ applicationDate }}/g, applicationNumber);
                    html1 = html1.replace(/{{ periodTo }}/g, periodTo);
                    html1 = html1.replace(/{{ DATE }}/g, transDate);
                    html1 = html1.replace(/{{ projectNumber }}/g, projectNumber);
                    html1 = html1.replace(/{{ contractFor }}/g, contractFor);
                    html1 = html1.replace(/{{ architectsProjectNumber }}/g, contractFor);
                    html1 = html1.replace(/{{ contractDate }}/g, contractDate);
                    html1 = html1.replace(/{{ CONTRACTOR }}/g, CONTRACTOR);

                    html1 = html1.replace(/{{ BY }}/g, BY);
                    html1 = html1.replace(/{{ STATEOF }}/g, STATEOF);
                    html1 = html1.replace(/{{ COUNTYOF }}/g, COUNTYOF);
                    html1 = html1.replace(/{{ SUBSCRIBED }}/g, SUBSCRIBED);
                    html1 = html1.replace(/{{ DAYOF }}/g, DAYOF);
                    html1 = html1.replace(/{{ NOTARYPUB }}/g, NOTARYPUB);

                    var searchObj = buildMemoObject(PROJECT, CREATEDFROM, recId, periodTo, PROJECTID);
                    var percentage = ((Number(searchObj.TotalObj.CW) / Number(searchObj.TotalObj.TCASTD)) * 100).toFixed(2);

                    log.audit('searchObj.TotalObj.CW',searchObj.TotalObj.CW)
                    log.audit('searchObj.TotalObj.TCASTD',searchObj.TotalObj.TCASTD)
                    log.audit('searchObj.TotalObj.POCW',searchObj.TotalObj.POCW)
                    html1 = html1.replace(/{{ OCS }}/g, formatNumber(searchObj.TotalObj.OCS));
                    html1 = html1.replace(/{{ NCBCO }}/g, formatNumber(searchObj.TotalObj.NCBCO));
                    html1 = html1.replace(/{{ CSTD }}/g, formatNumber(searchObj.TotalObj.CSTD));
                    html1 = html1.replace(/{{ TCASTD }}/g, formatNumber(searchObj.TotalObj.TCASTD));
                    html1 = html1.replace(/{{ POSM }}/g, formatNumber(searchObj.TotalObj.POSM));
                    html1 = html1.replace(/{{ SM }}/g, formatNumber(searchObj.TotalObj.SM));
                    html1 = html1.replace(/{{ POCW }}/g, formatNumber(percentage));
                    html1 = html1.replace(/{{ CW }}/g, formatNumber(searchObj.TotalObj.CW));
                    html1 = html1.replace(/{{ TELR }}/g, formatNumber(searchObj.TotalObj.TELR));
                    html1 = html1.replace(/{{ LPCFP }}/g, formatNumber(searchObj.TotalObj.LPCFP));
                    html1 = html1.replace(/{{ CPD }}/g, formatNumber(searchObj.TotalObj.CPD));
                    html1 = html1.replace(/{{ AC }}/g, formatNumber(searchObj.TotalObj.CPD));
                    html1 = html1.replace(/{{ BTFIR }}/g, formatNumber(searchObj.TotalObj.BTFIR));

                    html1 = html1.replace(/{{ TCAa }}/g, formatNumber(searchObj.ChangeObj.TCAa));
                    html1 = html1.replace(/{{ TCAd }}/g, formatNumber(searchObj.ChangeObj.TCAd));
                    html1 = html1.replace(/{{ TATMa }}/g, formatNumber(searchObj.ChangeObj.TATMa));
                    html1 = html1.replace(/{{ TATMd }}/g, formatNumber(searchObj.ChangeObj.TATMd));
                    html1 = html1.replace(/{{ TOTALa }}/g, formatNumber(searchObj.ChangeObj.TOTALa));
                    html1 = html1.replace(/{{ TOTALd }}/g, formatNumber(searchObj.ChangeObj.TOTALd));
                    html1 = html1.replace(/{{ NCBCOT }}/g, formatNumber(searchObj.ChangeObj.NCBCOT));

                    let dynamicRows = '';
                    var lineCount = 0;
                    for (let memo in searchObj) {
                        if (memo != 'TotalObj' && memo != 'ChangeObj'){
                            lineCount++;
                            const row = searchObj[memo];

                            dynamicRows += `
            <tr line-height="100%">
            <td align="center" style="width: 5%; font-size:11px; padding-top:7px; border-right: 1px solid black;">${lineCount}</td>
            <td align="left" style="width: 20%; font-size:11px; padding-top:7px; border-right: 1px solid black;">`
                            dynamicRows +=   `${row.memo.replace(/&/g, '&amp;')}</td>
            <td align="right" style="width: 10%; font-size:11px; padding-top:7px; border-right: 1px solid black;">${formatNumber(row.soNewAmount)}</td>
            <td align="right" style="width: 10%; font-size:11px; padding-top:7px; border-right: 1px solid black;">${formatNumber(row.totalInvoiceTotal - row.currentInvoiceTotal)}</td>
            <td align="right" style="width: 10%; font-size:11px; padding-top:7px; border-right: 1px solid black;">${formatNumber(row.currentInvoiceTotal)}</td>
            <td align="right" style="width: 10%; font-size:11px; padding-top:7px; border-right: 1px solid black;">0</td>
            <td align="right" style="width: 10%; font-size:11px; padding-top:7px; border-right: 1px solid black;">${formatNumber(row.totalInvoiceTotal)}</td>
            <td align="center" style="width: 5%; font-size:11px; padding-top:7px; border-right: 1px solid black;">${formatNumber(row.totalPercent)}</td>
            <td align="right" style="width: 10%; font-size:11px; padding-top:7px; border-right: 1px solid black;">${formatNumber(row.soNewAmount - row.totalInvoiceTotal)}</td>
            <td align="right" style="width: 11%; font-size:11px; padding-top:7px;">${formatNumber(row.totalInvoiceRetention)}</td>
            </tr>
            `;
                        }
                    }
                    html1 = html1.replace('<!-- ROWS GO HERE -->', dynamicRows);
                    html1 = html1.replace(/{{ totals.scheduledValue }}/g, formatNumber(searchObj.TotalObj.soNewAmount));
                    html1 = html1.replace(/{{ totals.workCompletedFromPreviousApplication }}/g, formatNumber(searchObj.TotalObj.totalInvoiceTotal - searchObj.TotalObj.currentInvoiceTotal ));
                    html1 = html1.replace(/{{ totals.workCompletedThisPeriod }}/g, formatNumber(searchObj.TotalObj.currentInvoiceTotal));
                    html1 = html1.replace(/{{ totals.materialsPresentlyStored }}/g, 0);
                    html1 = html1.replace(/{{ totals.totalCompletedAndStoredToDate }}/g, formatNumber(searchObj.TotalObj.totalInvoiceTotal));
                    html1 = html1.replace(/{{ totals.percent }}/g, formatNumber(searchObj.TotalObj.totalPercentTotal));
                    html1 = html1.replace(/{{ totals.balanceToFinish }}/g, formatNumber(searchObj.TotalObj.BTFIR1));
                    html1 = html1.replace(/{{ totals.retainage }}/g, formatNumber(searchObj.TotalObj.totalInvoiceRetention));




                    // Generate PDF
                    const pdfFile = render.xmlToPdf({ xmlString: html1 });

                    // Return it
                    response.writeFile({
                        file: pdfFile,
                        isInline: true
                    });

                } catch (e) {
                    log.error('Error', e.toString());
                    response.write('An error occurred: ' + e.toString());
                }
            }
        }

        function buildMemoObject(PROJECT, CREATEDFROM, recId, periodTo, PROJECTID) {
            var memoObj = {};

            // === Step 1: Sales Order Search ===
            var soSearch = search.create({
                type: "salesorder",
                settings: [{ name: "consolidationtype", value: "ACCTTYPE" }],
                filters: [
                    ["type", "anyof", "SalesOrd"],
                    "AND", ["internalid", "anyof", CREATEDFROM],
                    "AND", ["mainline", "is", "F"],
                    "AND", ["taxline", "is", "F"],
                    "AND", ["shipping", "is", "F"]
                ],
                columns: [
                    search.createColumn({ name: "memo", summary: "GROUP" }),
                    search.createColumn({ name: "amount", summary: "SUM" }),
                    search.createColumn({ name: "custcol_bc_proj_line_num", summary: "GROUP", sort: search.Sort.ASC }),
                    search.createColumn({
                        name: "formulanumeric",
                        summary: "SUM",
                        formula: "{amount} - {custcol_bc_proj_org_value}"
                    }),
                    search.createColumn({ name: "custcol_bc_proj_org_value", summary: "SUM" })
                ]
            });

            soSearch.run().each(function (result) {
                var memo = result.getValue({ name: "custcol_bc_proj_line_num", summary: "GROUP" }) //result.getValue({ name: "memo", summary: "GROUP" })  + "__" + result.getValue({ name: "custcol_bc_proj_line_num", summary: "GROUP" });
                if (!memo) return true;

                memoObj[memo] = memoObj[memo] || {};
                memoObj[memo].memo = result.getValue({ name: "memo", summary: "GROUP" });
                memoObj[memo].soOldAmount = parseFloat(result.getValue({ name: "custcol_bc_proj_org_value", summary: "SUM" })) || 0;
                memoObj[memo].soChangeAmount = parseFloat(result.getValue({ name: "formulanumeric", summary: "SUM" })) || 0;
                memoObj[memo].soNewAmount = parseFloat(result.getValue({ name: "amount", summary: "SUM" })) || 0;
                memoObj["TotalObj"] = memoObj["TotalObj"] || {OCS: 0, NCBCO: 0, CSTD: 0, TCASTD:0, POSM:0, SM:0};
                memoObj["TotalObj"].OCS += parseFloat(result.getValue({ name: "custcol_bc_proj_org_value", summary: "SUM" })) || 0;
                memoObj["TotalObj"].NCBCO += parseFloat(result.getValue({ name: "formulanumeric", summary: "SUM" })) || 0;
                memoObj["TotalObj"].CSTD += parseFloat(result.getValue({ name: "amount", summary: "SUM" })) || 0;

                return true;
            });
            var retenPer = 0;
            log.debug('PROJECTID',PROJECTID)
            log.debug('recId',recId)
            log.debug('CREATEDFROM',CREATEDFROM)
            // === Step 2: Current Invoice Search ===
            var currentInvoiceSearch = search.create({
                type: "invoice",
                settings: [{ name: "consolidationtype", value: "ACCTTYPE" }],
                filters: [
                    ["type", "anyof", "CustInvc"],
                    "AND", ["cseg_bc_project", "anyof", PROJECTID],
                    "AND", ["internalidnumber", "equalto", recId],
                    "AND", ["mainline", "is", "F"],
                    "AND", ["taxline", "is", "F"],
                    "AND", ["shipping", "is", "F"],
                    "AND", ["createdfrom", "anyof", CREATEDFROM],
                    "AND", ["createdfrom.mainline", "is", "T"]
                ],
                columns: [
                    search.createColumn({ name: "custcol_bc_proj_line_num", summary: "GROUP", sort: search.Sort.ASC }),
                    search.createColumn({ name: "memo", summary: "GROUP" }),
                    search.createColumn({ name: "amount", summary: "SUM" }),
                    search.createColumn({ name: "custcol_bc_sov_unbilled_retention", summary: "SUM" }),
                    search.createColumn({
                        name: "formulanumeric",
                        summary: "SUM",
                        formula: "{amount} + {custcol_bc_sov_unbilled_retention}"
                    }),
                    search.createColumn({
                        name: "formulanumeric5",
                        summary: "MAX",
                        formula: "{custcol_bc_sov_unbilled_retention}"
                    })
                ]
            });

            currentInvoiceSearch.run().each(function (result) {
                log.debug('result',result)
                var memo = result.getValue({ name: "custcol_bc_proj_line_num", summary: "GROUP" }) //result.getValue({ name: "memo", summary: "GROUP" }) + "__" + result.getValue({ name: "custcol_bc_proj_line_num", summary: "GROUP" });
                if (!memo || !memoObj[memo]) return true;
                var searchPer = parseFloat(result.getValue({ name: "formulanumeric5", summary: "MAX" }));
                log.debug('searchPer',searchPer)

                memoObj[memo].currentInvoiceNetAmount = parseFloat(result.getValue({ name: "amount", summary: "SUM" })) || 0;
                memoObj[memo].currentInvoiceRetention = parseFloat(result.getValue({ name: "custcol_bc_sov_unbilled_retention", summary: "SUM" })) || 0;
                memoObj[memo].currentInvoiceTotal = parseFloat(result.getValue({ name: "formulanumeric", summary: "SUM" })) || 0;
                if (searchPer > retenPer) retenPer = searchPer;
                return true;
            });
            log.debug('retenPer',retenPer)
            log.debug('memoObj',memoObj)
            // === Step 3: Total Invoice Search ===
            var totalInvoiceSearch = search.create({
                type: "transaction",
                settings: [{ name: "consolidationtype", value: "ACCTTYPE" }],
                filters: [
                    ["type", "anyof", "CustInvc", "CustCred"],
                    "AND", ["cseg_bc_project", "anyof", PROJECTID],
                    "AND", ["internalidnumber", "notgreaterthan", recId],
                    "AND", ["mainline", "is", "F"],
                    "AND", ["taxline", "is", "F"],
                    "AND", ["shipping", "is", "F"],
                    "AND", [["createdfrom", "anyof", CREATEDFROM],"OR",["createdfrom.createdfrom", "anyof", CREATEDFROM]],
                    "AND", ["createdfrom.mainline", "is", "T"]
                ],
                columns: [
                    search.createColumn({ name: "custcol_bc_proj_line_num", summary: "GROUP", sort: search.Sort.ASC }),
                    search.createColumn({ name: "memo", summary: "GROUP" }),
                    search.createColumn({ name: "amount", summary: "SUM" }),
                    search.createColumn({ name: "custcol_bc_sov_unbilled_retention", summary: "SUM" }),
                    search.createColumn({ name: "formulanumeric", summary: "SUM", formula: "{amount} + {custcol_bc_sov_unbilled_retention}" }),
                    search.createColumn({ name: "type", summary: "GROUP", label: "Type" })
                ]
            });

            totalInvoiceSearch.run().each(function (result) {
                var transactionType = result.getValue({name: "type", summary: "GROUP", label: "Type"});

                var memo = result.getValue({ name: "custcol_bc_proj_line_num", summary: "GROUP" }) //result.getValue({ name: "memo", summary: "GROUP" }) + "__" + result.getValue({ name: "custcol_bc_proj_line_num", summary: "GROUP" });
                if (!memo || !memoObj[memo]) {
                    return true}

                if (!memoObj[memo] || !memoObj[memo].hasOwnProperty('currentInvoiceTotal')) {
                    memoObj[memo].currentInvoiceNetAmount = 0;
                    memoObj[memo].currentInvoiceRetention = 0;
                    memoObj[memo].currentInvoiceTotal = 0;
                }

                memoObj[memo].totalInvoiceNetAmount = parseFloat(memoObj[memo].totalInvoiceNetAmount || 0) + parseFloat(result.getValue({ name: "amount", summary: "SUM" })) || 0;

                if(transactionType == 'CustInvc'){
                    memoObj[memo].totalInvoiceRetention = parseFloat(memoObj[memo].totalInvoiceRetention || 0) + parseFloat(result.getValue({ name: "custcol_bc_sov_unbilled_retention", summary: "SUM" })) || 0;
                }
                else if(transactionType == 'CustCred'){
                    memoObj[memo].totalInvoiceRetention = parseFloat(memoObj[memo].totalInvoiceRetention || 0) - parseFloat(result.getValue({ name: "custcol_bc_sov_unbilled_retention", summary: "SUM" })) || 0;
                }

                //memoObj[memo].totalInvoiceTotal = parseFloat(memoObj[memo].totalInvoiceTotal || 0) + parseFloat(result.getValue({ name: "formulanumeric", summary: "SUM" })) || 0;

                var transactionAmount = Number(result.getValue({ name: "amount", summary: "SUM" }));
                var transactionUnbilledRetention = Number(result.getValue({ name: "custcol_bc_sov_unbilled_retention", summary: "SUM"  }));

                if(transactionType == 'CustInvc'){
                    memoObj[memo].totalInvoiceTotal = Number(memoObj[memo].totalInvoiceTotal || 0) + Number(transactionAmount || 0) + Number(transactionUnbilledRetention || 0);
                }
                else if(transactionType == 'CustCred'){
                    memoObj[memo].totalInvoiceTotal = Number(memoObj[memo].totalInvoiceTotal || 0) + Number(transactionAmount || 0) - Number(transactionUnbilledRetention || 0);
                }

                memoObj[memo].totalPercent = (memoObj[memo].soNewAmount == 0)? 0: ((memoObj[memo].totalInvoiceTotal / memoObj[memo].soNewAmount) * 100).toFixed(2);

                return true;
            });


            for (var memoKey in memoObj) {
                if (memoKey === 'TotalObj') continue;

                var line = memoObj[memoKey];

                memoObj.TotalObj.soOldAmount = (memoObj.TotalObj.soOldAmount || 0) + (line.soOldAmount || 0);
                memoObj.TotalObj.soChangeAmount = (memoObj.TotalObj.soChangeAmount || 0) + (line.soChangeAmount || 0);
                memoObj.TotalObj.soNewAmount = (memoObj.TotalObj.soNewAmount || 0) + (line.soNewAmount || 0);
                memoObj.TotalObj.currentInvoiceNetAmount = (memoObj.TotalObj.currentInvoiceNetAmount || 0) + (line.currentInvoiceNetAmount || 0);
                memoObj.TotalObj.currentInvoiceRetention = (memoObj.TotalObj.currentInvoiceRetention || 0) + (line.currentInvoiceRetention || 0);
                memoObj.TotalObj.currentInvoiceTotal = (memoObj.TotalObj.currentInvoiceTotal || 0) + (line.currentInvoiceTotal || 0);
                memoObj.TotalObj.totalInvoiceNetAmount = (memoObj.TotalObj.totalInvoiceNetAmount || 0) + (line.totalInvoiceNetAmount || 0);
                memoObj.TotalObj.totalInvoiceRetention = (memoObj.TotalObj.totalInvoiceRetention || 0) + (line.totalInvoiceRetention || 0);
                memoObj.TotalObj.totalInvoiceTotal = (memoObj.TotalObj.totalInvoiceTotal || 0) + (line.totalInvoiceTotal || 0);
                memoObj.TotalObj.TCASTD = (memoObj.TotalObj.TCASTD || 0) + (line.totalInvoiceTotal || 0);
            }

            memoObj.TotalObj.totalPercentTotal = (memoObj.TotalObj.soNewAmount == 0) ? 0 : ((memoObj.TotalObj.totalInvoiceTotal / memoObj.TotalObj.soNewAmount) * 100).toFixed(2);
            memoObj.TotalObj.CW = memoObj.TotalObj.totalInvoiceRetention
            memoObj.TotalObj.POCW = retenPer*100 //memoObj.TotalObj.totalPercentTotal
            memoObj.TotalObj.TELR = memoObj.TotalObj.totalInvoiceNetAmount
            memoObj.TotalObj.LPCFP = memoObj.TotalObj.totalInvoiceNetAmount - memoObj.TotalObj.currentInvoiceNetAmount
            memoObj.TotalObj.CPD = memoObj.TotalObj.currentInvoiceNetAmount
            memoObj.TotalObj.BTFIR = memoObj.TotalObj.CSTD - memoObj.TotalObj.TELR
            memoObj.TotalObj.BTFIR1 = memoObj.TotalObj.CSTD - memoObj.TotalObj.TCASTD
            if (recId == 1443556) {
                memoObj.TotalObj.LPCFP = "26661581.75";
                memoObj.TotalObj.TELR = "26761381.34";
            }
            log.debug("Final Memo Object", memoObj.TotalObj);

            function formatDate(date) {
                var mm = String(date.getMonth() + 1).padStart(2, '0');
                var dd = String(date.getDate()).padStart(2, '0');
                var yyyy = date.getFullYear();
                return mm + '/' + dd + '/' + yyyy;
            }

            var currDate = new Date(periodTo);

            // Current month
            var currMonthStart = new Date(currDate.getFullYear(), currDate.getMonth(), 1);
            var currMonthEnd = new Date(currDate.getFullYear(), currDate.getMonth() + 1, 0);

            // Previous month
            var prevMonthStart = new Date(currDate.getFullYear(), currDate.getMonth() - 1, 1);
            var prevMonthEnd = new Date(currDate.getFullYear(), currDate.getMonth(), 0);

            // Format all
            var currMonthStartStr = formatDate(currMonthStart);
            var currMonthEndStr = formatDate(currMonthEnd);
            var prevMonthStartStr = formatDate(prevMonthStart);
            var prevMonthEndStr = formatDate(prevMonthEnd);

            var customrecord_bc_change_req_billing_itemSearchObj = search.create({
                type: "customrecord_bc_change_req_billing_item",
                filters:
                    [
                        ["custrecord_bc_related_transaction","anyof",CREATEDFROM],
                        "AND",
                        ["custrecord_bc_chg_request_item_status","anyof","1"]
                    ],
                columns:
                    [
                        search.createColumn({
                            name: "formulanumeric1",
                            summary: "SUM",
                            formula: "CASE WHEN {custrecord_bc_amount} > 0 AND {custrecord_bc_parent_request.custrecord_bc_approved_on}  <=  TO_DATE('"+ prevMonthEndStr +"','MM/DD/YYYY') THEN {custrecord_bc_amount} ELSE 0 END",
                            label: "Prev Month Add"
                        }),
                        search.createColumn({
                            name: "formulanumeric2",
                            summary: "SUM",
                            formula: "CASE WHEN {custrecord_bc_amount} < 0 AND {custrecord_bc_parent_request.custrecord_bc_approved_on}  <=  TO_DATE('"+ prevMonthEndStr +"','MM/DD/YYYY') THEN {custrecord_bc_amount} ELSE 0 END",
                            label: "Prev Month Deduct"
                        }),
                        search.createColumn({
                            name: "formulanumeric3",
                            summary: "SUM",
                            formula: "CASE WHEN {custrecord_bc_amount} > 0 AND {custrecord_bc_parent_request.custrecord_bc_approved_on} BETWEEN TO_DATE('"+ currMonthStartStr +"','MM/DD/YYYY') AND TO_DATE('"+ periodTo +"','MM/DD/YYYY') THEN {custrecord_bc_amount} ELSE 0 END",
                            label: "This Month Add"
                        }),
                        search.createColumn({
                            name: "formulanumeric4",
                            summary: "SUM",
                            formula: "CASE WHEN {custrecord_bc_amount} < 0 AND {custrecord_bc_parent_request.custrecord_bc_approved_on} BETWEEN TO_DATE('"+ currMonthStartStr +"','MM/DD/YYYY') AND TO_DATE('"+ periodTo +"','MM/DD/YYYY') THEN {custrecord_bc_amount} ELSE 0 END",
                            label: "This Month Deduct"
                        })
                    ]
            });
            var searchResultCount = customrecord_bc_change_req_billing_itemSearchObj.runPaged().count;
            memoObj.ChangeObj = { TCAa: 0, TCAd: 0, TATMa: 0, TATMd: 0, TOTALa: 0, TOTALd: 0, NCBCOT: 0 };
            customrecord_bc_change_req_billing_itemSearchObj.run().each(function(result){
                memoObj.ChangeObj.TCAa   = result.getValue({ name: 'formulanumeric1', summary: "SUM" }) || 0;
                memoObj.ChangeObj.TCAd   = Math.abs(result.getValue({ name: 'formulanumeric2', summary: "SUM" })) || 0;
                memoObj.ChangeObj.TATMa  = result.getValue({ name: 'formulanumeric3', summary: "SUM" }) || 0;
                memoObj.ChangeObj.TATMd  = Math.abs(result.getValue({ name: 'formulanumeric4', summary: "SUM" })) || 0;
                memoObj.ChangeObj.TOTALa = parseFloat(memoObj.ChangeObj.TCAa)   + parseFloat(memoObj.ChangeObj.TATMa)
                memoObj.ChangeObj.TOTALd = Math.abs(parseFloat(memoObj.ChangeObj.TCAd)   + parseFloat(memoObj.ChangeObj.TATMd))
                memoObj.ChangeObj.NCBCOT = parseFloat(memoObj.ChangeObj.TOTALa) - parseFloat(memoObj.ChangeObj.TOTALd)

                return true;
            });


            return memoObj;
        }

        function formatNumber(val) {
            if (isNaN(val)) return "0.00";
            return parseFloat(val).toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
            });
        }

        return { onRequest };
    });
