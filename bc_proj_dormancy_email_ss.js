/**
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 */
define(['N/query', 'N/email', 'N/runtime', 'N/url', 'N/log'], 
(query, email, runtime, url, log) => {

    const execute = (context) => {
        try {
            const scriptObj = runtime.getCurrentScript();
            
            // 1. Retrieve parameters
            let emailAuthor = scriptObj.getParameter({ name: 'custscript_author_email' });
            let recipientEmail = 697221; //scriptObj.getParameter({ name: 'custscript_recipient_email' });
            const savedSearchId = scriptObj.getParameter({ name: 'custscript_bc_dorm_saved_search' });
            const subsidiaryParam = scriptObj.getParameter({ name: 'custscript_subsidiary_default' });

            if (!emailAuthor) {
                try {
                    const empResult = query.runSuiteQL({
                        query: "SELECT id FROM employee WHERE isinactive = 'F'"
                    }).asMappedResults();
                    if (empResult && empResult.length > 0) {
                        emailAuthor = empResult[0].id;
                    }
                } catch (err) {
                    log.error('Error finding default employee author', err);
                }
            }

            if (!emailAuthor) {
                log.error('Missing Configuration', 'An active employee author could not be found or configured.');
                return;
            }

            if (!recipientEmail) {
                recipientEmail = 697221; //'sean.bartlett@apg.company';
            }

            const subsidiaryId = subsidiaryParam ? String(subsidiaryParam).trim() : '23';

            log.audit('Scheduled Script Started', `Email Author: ${emailAuthor}, Recipient: ${recipientEmail}, Subsidiary: ${subsidiaryId}`);

            // 2. Define SuiteQL query
            const sqlText = `
WITH
project_base AS (
    SELECT
        proj.id                             AS project_id,
        proj.name                           AS project_name,
        proj.custrecord_bc_proj_contract    AS so_id,
        so.foreigntotal                     AS revised_contract_value,
        -- PLACEHOLDER: Replace 'NULL' with your custom "Last Day" field ID if/when created.
        NULL                                AS custom_last_day
    FROM customrecord_cseg_bc_project proj
    INNER JOIN transaction so ON so.id = proj.custrecord_bc_proj_contract
    WHERE proj.isinactive = 'F'
      AND so.type = 'SalesOrd'
      AND proj.custrecord_bc_proj_subsidiary = ${subsidiaryId}
      AND so.custbody_bc_is_bluecollar_contract = 'T'
),

project_billings_and_ar AS (
    -- Sums billings and open AR, and tracks the latest invoice date for invoices created from the Suitelet (context = 'SLT')
    SELECT
        tl.createdfrom AS so_id,
        SUM(NVL(inv.foreigntotal, 0)) AS billed_to_date,
        SUM(NVL(inv.foreignamountunpaid, 0)) AS open_ar,
        MAX(inv.trandate) AS last_invoice_date
    FROM transaction inv
    INNER JOIN transactionline tl ON tl.transaction = inv.id AND tl.mainline = 'T'
    WHERE inv.type = 'CustInvc'
      AND EXISTS (
          SELECT 1 
          FROM systemnote sn 
          WHERE sn.recordid = inv.id 
            AND sn.context = 'SLT'
      )
    GROUP BY tl.createdfrom
),

project_last_labor AS (
    -- Gets details of the most recent labor Journal Entry line where department matches the project's department
    SELECT
        project_id,
        last_labor_date,
        last_labor_je_no,
        last_labor_je_amount,
        last_labor_je_account
    FROM (
        SELECT
            tl.cseg_bc_project AS project_id,
            t.trandate AS last_labor_date,
            t.tranid AS last_labor_je_no,
            tl.foreignamount AS last_labor_je_amount,
            acct.fullname AS last_labor_je_account,
            ROW_NUMBER() OVER(PARTITION BY tl.cseg_bc_project ORDER BY t.trandate DESC, t.id DESC) AS rn
        FROM transaction t
        INNER JOIN transactionline tl ON tl.transaction = t.id
        INNER JOIN customrecord_cseg_bc_project proj ON proj.id = tl.cseg_bc_project
        INNER JOIN account acct ON acct.id = tl.expenseaccount
        WHERE t.type = 'Journal'
          AND tl.department = proj.custrecord_bc_department
          AND (LOWER(acct.fullname) LIKE '%labor%' OR LOWER(acct.description) LIKE '%labor%')
    )
    WHERE rn = 1
)

SELECT
    pb.project_id,
    pb.project_name,
    pb.revised_contract_value,
    NVL(pba.billed_to_date, 0) AS billed_to_date,
    (pb.revised_contract_value - NVL(pba.billed_to_date, 0)) AS left_to_bill,
    NVL(pba.open_ar, 0) AS open_ar,
    pba.last_invoice_date,
    pl.last_labor_date,
    pl.last_labor_je_no,
    pl.last_labor_je_amount,
    pl.last_labor_je_account,
    pb.custom_last_day
FROM project_base pb
LEFT JOIN project_billings_and_ar pba ON pba.so_id = pb.so_id
LEFT JOIN project_last_labor pl ON pl.project_id = pb.project_id
WHERE
    -- 1. CONTRACT BILLING / PAYMENT STATUS FILTER
    -- Either: Not Billed In Full (left_to_bill > 0)
    -- Or: Not Paid In Full (Open AR > 0)
    (
        (pb.revised_contract_value - NVL(pba.billed_to_date, 0) > 0)
        OR (NVL(pba.open_ar, 0) > 0)
    )
    
    -- 2. DORMANCY DATE FILTER (60 to 90 Days ago)
    -- Checks if Sysdate - 90 <= date <= Sysdate - 60 for at least one activity date
    AND (
        (pba.last_invoice_date >= CURRENT_DATE - 90 AND pba.last_invoice_date <= CURRENT_DATE - 60)
        OR (pl.last_labor_date >= CURRENT_DATE - 90 AND pl.last_labor_date <= CURRENT_DATE - 60)
        OR (pb.custom_last_day >= CURRENT_DATE - 90 AND pb.custom_last_day <= CURRENT_DATE - 60)
    )
`;

            // 3. Execute SuiteQL
            log.debug('Executing SuiteQL Query');
            const results = query.runSuiteQL({ query: sqlText }).asMappedResults();
            log.audit('Query Results Count', results.length);

            if (results.length === 0) {
                log.audit('No projects found matching the dormancy criteria.');
                return;
            }

            // 4. Build HTML Table of Projects
            let tableHtml = '<table border="1" cellpadding="5" style="border-collapse: collapse; font-family: sans-serif; font-size: 13px;">';
            tableHtml += '<tr style="background-color: #0E2841; color: white;">';
            tableHtml += '<th>Project ID</th>';
            tableHtml += '<th>Project Name</th>';
            tableHtml += '<th>Revised Contract Value</th>';
            tableHtml += '<th>Billed to Date</th>';
            tableHtml += '<th>Left to Bill</th>';
            tableHtml += '<th>Open AR</th>';
            tableHtml += '<th>Last Invoice Date</th>';
            tableHtml += '<th>Last Labor Date</th>';
            tableHtml += '<th>Last Labor JE</th>';
            tableHtml += '<th>Last Labor Amount</th>';
            tableHtml += '<th>Last Labor Account</th>';
            tableHtml += '</tr>';

            const formatCurrency = (val) => {
                return '$' + Number(val).toFixed(2).replace(/\d(?=(\d{3})+\.)/g, '$&,');
            };

            const formatDate = (val) => {
                return val ? val : '-';
            };

            results.forEach(row => {
                tableHtml += '<tr>';
                tableHtml += `<td>${row.project_id}</td>`;
                tableHtml += `<td><strong>${row.project_name}</strong></td>`;
                tableHtml += `<td align="right">${formatCurrency(row.revised_contract_value)}</td>`;
                tableHtml += `<td align="right">${formatCurrency(row.billed_to_date)}</td>`;
                tableHtml += `<td align="right">${formatCurrency(row.left_to_bill)}</td>`;
                tableHtml += `<td align="right">${formatCurrency(row.open_ar)}</td>`;
                tableHtml += `<td align="center">${formatDate(row.last_invoice_date)}</td>`;
                tableHtml += `<td align="center">${formatDate(row.last_labor_date)}</td>`;
                tableHtml += `<td align="center">${row.last_labor_je_no ? row.last_labor_je_no : '-'}</td>`;
                tableHtml += `<td align="right">${row.last_labor_je_amount ? formatCurrency(row.last_labor_je_amount) : '-'}</td>`;
                tableHtml += `<td>${row.last_labor_je_account ? row.last_labor_je_account : '-'}</td>`;
                tableHtml += '</tr>';
            });
            tableHtml += '</table>';

            // 5. Generate Saved Search link
            let savedSearchLinkHtml = '';
            if (savedSearchId) {
                const scheme = 'https://';
                const domain = url.resolveDomain({ hostType: url.HostType.APPLICATION });
                const searchUrl = url.resolveTaskLink({
                    id: 'LIST_SEARCHRESULTS',
                    params: { searchid: savedSearchId }
                });
                const fullUrl = scheme + domain + searchUrl;
                savedSearchLinkHtml = `<p style="margin-top: 20px;"><a href="${fullUrl}" style="background-color: #0E2841; color: white; padding: 10px 15px; text-decoration: none; border-radius: 4px; font-weight: bold;">View Saved Search in NetSuite</a></p>`;
            } else {
                savedSearchLinkHtml = '<p style="color: #666; font-style: italic;">Note: A Saved Search link is not available because the Saved Search ID parameter was not configured.</p>';
            }

            // 6. Build Email Body
            const emailBody = `
                <div style="font-family: sans-serif; color: #333; line-height: 1.5; max-width: 800px;">
                    <h2 style="color: #0E2841; border-bottom: 2px solid #0E2841; padding-bottom: 5px;">Dormant Projects Report</h2>
                    <p>The following active projects have been identified as dormant based on the updated close-out criteria (between 60 and 90 days since the last Invoice, labor Journal Entry, or custom "Last Day" date):</p>
                    ${tableHtml}
                    ${savedSearchLinkHtml}
                    <p style="font-size: 11px; color: #777; margin-top: 30px; border-top: 1px solid #ddd; padding-top: 10px;">
                        This is an automated message from the NetSuite Project Dormancy Email alert script.
                    </p>
                </div>
            `;

            // 7. Send Email
            email.send({
                author: emailAuthor,
                recipients: recipientEmail,
                subject: 'Action Required: Dormant Projects Close-out Report',
                body: emailBody
            });

            log.audit('Email Sent Successfully', `Report emailed to ${recipientEmail}`);

        } catch (e) {
            log.error('Error in Scheduled Script', e);
        }
    };

    return { execute };
});
