/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define([
    'N/search',
    'N/record',
    'N/email',
    'N/format',
    'N/log',
    'N/url',
    'N/runtime'
], (search, record, email, format, log, url, runtime) => {

    const PARAMS = {
        DAYS_BEFORE_PM: 'custscript_bc_bn_days_before_pm',
        DAYS_BEFORE_ACCOUNTING: 'custscript_bc_bn_days_before_acc',
        EMAIL_SENDER: 'custscript_bc_bn_email_sender',
        PM_EXTRA_EMAILS: 'custscript_bc_bn_pm_extra_emails',
        ACCOUNTING_EXTRA_EMAILS: 'custscript_bc_bn_acc_extra_emails',
        ACCOUNTING_EMAIL: 'custscript_bc_bn_accounting_email',
        TEST_CURRENT_DATE: 'custscript_bc_bn_test_current_date'
    };

    const DEFAULTS = {
        DAYS_BEFORE_PM: 3,
        DAYS_BEFORE_ACCOUNTING: 1,
        EMAIL_SENDER: -5,
        PM_EXTRA_EMAILS: ['jainil.suthar@bluecollar.cloud'],
        ACCOUNTING_EXTRA_EMAILS: ['jainil.suthar@bluecollar.cloud'],
        ACCOUNTING_EMAIL: 697221
    };

    const RECORDS = {
        PROJECT: 'customrecord_cseg_bc_project',
        PROJECT_CONTACT: 'customrecord_bc_project_contact_list',
        HOLIDAY: 'customrecord_bc_holiday_list',
        BILLING_HISTORY: 'customrecord_bc_project_billing_history',
        CHANGE_REQUEST: 'customrecord_bc_change_req'
    };

    const FIELDS = {
        PROJECT_DISPLAY: 'name',
        MAIN_PM: 'custrecord_bc_proj_manager',
        BILL_DATE: 'custrecord_bill_date',
        CONTRACT_SALES_ORDER: 'custrecord_bc_proj_contract',
        PROJECT_SEGMENT: 'cseg_bc_project',
        HISTORY_PROJECT: 'custrecord_bc_bh_project',
        HISTORY_CYCLE_DATE: 'custrecord_bc_bh_cycle_date',
        HISTORY_STATUS: 'custrecord_bc_bh_status',
        HISTORY_NO_BILL_REASON: 'custrecord_bc_bh_no_bill_reason',
        HISTORY_RELATED_INVOICES: 'custrecord_bc_bh_related_invoices',
        HISTORY_ACCOUNTING_NOTIFIED: 'custrecord_bc_bh_accounting_notified',
        CHANGE_PROJECT: 'custrecord_bc_blue_collar_proj',
        CHANGE_RELATED_TRANSACTIONS: 'custrecord_bc_related_transactions',
        CHANGE_REQUEST_STATUS: 'custrecord_bc_request_status'
    };


    const SUBSIDIARIES = {
        BLUECOLLAR: '23'
    };

    const SALES_ORDER_STATUSES = {
        BILLED: 'SalesOrd:G',
        CLOSED: 'SalesOrd:H'
    };

    // Create the custom-list values in this order and verify these IDs.
    const HISTORY_STATUS = {
        NO_BILLING: '1',
        INVOICED: '2'
    };

    const POSITIONS = {
        PHASE_PM: '3',
        ACCOUNTING: '4'
    };

    let settingsCache = null;
    let holidayCache = null;
    let billingHistoryTypeIdCache = null;

    // -----------------------------------------------------------------
    // PARAMETERS
    // -----------------------------------------------------------------
    const parseEmailList = (value, fallback) => {
        const source = value === null || value === undefined || String(value).trim() === ''
            ? fallback
            : value;
        const values = Array.isArray(source)
            ? source
            : String(source).split(/[,;\n]+/);

        return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
    };

    const parseIntegerParameter = (value, fallback, parameterId, allowNegative) => {
        const parsed = Number.parseInt(value, 10);
        const isValid = Number.isInteger(parsed) && (allowNegative || parsed >= 0);

        if (isValid) return parsed;

        log.audit('Parameter fallback', {
            parameterId,
            suppliedValue: value || '(blank)',
            fallback
        });
        return fallback;
    };

    const parseDateParameter = (value) => {
        if (!value) return null;

        try {
            const parsed = value instanceof Date
                ? value
                : format.parse({ value, type: format.Type.DATE });

            if (!(parsed instanceof Date) || Number.isNaN(parsed.getTime())) {
                throw new Error('Invalid date value');
            }
            return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
        } catch (error) {
            log.error('Invalid test date - actual date will be used', {
                parameterId: PARAMS.TEST_CURRENT_DATE,
                suppliedValue: value,
                error: error.message
            });
            return null;
        }
    };

    const getSettings = () => {
        if (settingsCache) return settingsCache;

        const script = runtime.getCurrentScript();
        settingsCache = {
            daysBeforePm: parseIntegerParameter(
                script.getParameter({ name: PARAMS.DAYS_BEFORE_PM }),
                DEFAULTS.DAYS_BEFORE_PM,
                PARAMS.DAYS_BEFORE_PM,
                false
            ),
            daysBeforeAccounting: parseIntegerParameter(
                script.getParameter({ name: PARAMS.DAYS_BEFORE_ACCOUNTING }),
                DEFAULTS.DAYS_BEFORE_ACCOUNTING,
                PARAMS.DAYS_BEFORE_ACCOUNTING,
                false
            ),
            emailSender: parseIntegerParameter(
                script.getParameter({ name: PARAMS.EMAIL_SENDER }),
                DEFAULTS.EMAIL_SENDER,
                PARAMS.EMAIL_SENDER,
                true
            ),
            pmExtraEmails: parseEmailList(
                script.getParameter({ name: PARAMS.PM_EXTRA_EMAILS }),
                DEFAULTS.PM_EXTRA_EMAILS
            ),
            accountingExtraEmails: parseEmailList(
                script.getParameter({ name: PARAMS.ACCOUNTING_EXTRA_EMAILS }),
                DEFAULTS.ACCOUNTING_EXTRA_EMAILS
            ),
            accountingEmail: parseIntegerParameter(
                script.getParameter({ name: PARAMS.ACCOUNTING_EMAIL }),
                DEFAULTS.ACCOUNTING_EMAIL,
                PARAMS.ACCOUNTING_EMAIL,
                false
            ),
            testCurrentDate: parseDateParameter(
                script.getParameter({ name: PARAMS.TEST_CURRENT_DATE })
            )
        };

        log.audit('Billing notification settings', {
            daysBeforePm: settingsCache.daysBeforePm,
            daysBeforeAccounting: settingsCache.daysBeforeAccounting,
            emailSender: settingsCache.emailSender,
            accountingEmail: settingsCache.accountingEmail,
            pmExtraEmails: settingsCache.pmExtraEmails,
            accountingExtraEmails: settingsCache.accountingExtraEmails,
            testMode: Boolean(settingsCache.testCurrentDate),
            testCurrentDate: settingsCache.testCurrentDate || '(blank - actual date used)'
        });

        return settingsCache;
    };

    // -----------------------------------------------------------------
    // DATE AND CYCLE HELPERS
    // -----------------------------------------------------------------

    const getOpenChangeOrderProjectIds = () => {
    const projectIds = new Set();

    const pagedResults = search.create({
        type: RECORDS.CHANGE_REQUEST,
        filters: [
            [`${FIELDS.CHANGE_PROJECT}.${FIELDS.BILL_DATE}`, 'noneof', '@NONE@'],
            'AND',
            [`${FIELDS.CHANGE_RELATED_TRANSACTIONS}.subsidiary`, 'anyof', SUBSIDIARIES.BLUECOLLAR],
            'AND',
            [FIELDS.CHANGE_REQUEST_STATUS, 'anyof', '2', '@NONE@']
        ],
        columns: [
            search.createColumn({
                name: FIELDS.CHANGE_PROJECT,
                summary: search.Summary.GROUP
            })
        ]
    }).runPaged({ pageSize: 1000 });

    pagedResults.pageRanges.forEach((pageRange) => {
        const page = pagedResults.fetch({ index: pageRange.index });
        page.data.forEach((result) => {
            const projectId = result.getValue({
                name: FIELDS.CHANGE_PROJECT,
                summary: search.Summary.GROUP
            });

            if (projectId) projectIds.add(String(projectId));
        });
    });

    return Array.from(projectIds);
};

const buildAnyOfFilterExpression = (fieldId, values) => {
    const chunks = [];

    for (let index = 0; index < values.length; index += 1000) {
        chunks.push(values.slice(index, index + 1000));
    }

    return chunks.reduce((expression, chunk) => {
        const chunkFilter = [fieldId, 'anyof', chunk];
        return expression ? [expression, 'OR', chunkFilter] : chunkFilter;
    }, null);
};
  
    const stripTime = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

    const getCurrentDate = () => {
        const testDate = getSettings().testCurrentDate;
        return testDate
            ? stripTime(new Date(testDate.getTime()))
            : stripTime(new Date());
    };

    const ymd = (date) => {
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${date.getFullYear()}-${month}-${day}`;
    };

    const sameMonth = (first, second) => {
        return first.getFullYear() === second.getFullYear() &&
            first.getMonth() === second.getMonth();
    };

    const getHolidays = (referenceDate) => {
        if (holidayCache) return holidayCache;

        holidayCache = new Set();
        const rangeStart = stripTime(referenceDate);
        const rangeEnd = stripTime(referenceDate);
        rangeEnd.setDate(rangeEnd.getDate() + 60);

        search.create({
            type: RECORDS.HOLIDAY,
            filters: [
                ['custrecord_bc_date', 'within',
                    format.format({ value: rangeStart, type: format.Type.DATE }),
                    format.format({ value: rangeEnd, type: format.Type.DATE })],
                'AND',
                ['isinactive', 'is', 'F'],
                'AND',
                ['custrecord_bc_half_day', 'is', 'F']
            ],
            columns: ['custrecord_bc_date']
        }).run().each((result) => {
            const value = result.getValue({ name: 'custrecord_bc_date' });
            if (value) {
                const holidayDate = format.parse({ value, type: format.Type.DATE });
                holidayCache.add(ymd(holidayDate));
            }
            return true;
        });

        log.audit('Holiday calendar loaded', {
            rangeStart: ymd(rangeStart),
            rangeEnd: ymd(rangeEnd),
            count: holidayCache.size,
            dates: Array.from(holidayCache)
        });

        return holidayCache;
    };

    const subtractBusinessDays = (date, numberOfDays, holidays) => {
        const result = stripTime(date);
        let remaining = numberOfDays;

        while (remaining > 0) {
            result.setDate(result.getDate() - 1);
            const dayOfWeek = result.getDay();
            const isWorkingDay = dayOfWeek !== 0 &&
                dayOfWeek !== 6 &&
                !holidays.has(ymd(result));
            if (isWorkingDay) remaining -= 1;
        }
        return result;
    };

    const getBillDates = (billText, referenceDate) => {
        const buildDate = (year, month) => {
            const lastDay = new Date(year, month + 1, 0).getDate();
            const billDay = String(billText).toUpperCase() === 'EOM'
                ? lastDay
                : Math.min(Number.parseInt(billText, 10), lastDay);
            return new Date(year, month, billDay);
        };

        const year = referenceDate.getFullYear();
        const month = referenceDate.getMonth();
        const thisMonth = buildDate(year, month);

        return {
            upcoming: thisMonth >= referenceDate
                ? thisMonth
                : buildDate(year, month + 1),
            recent: thisMonth <= referenceDate
                ? thisMonth
                : buildDate(year, month - 1)
        };
    };

    // -----------------------------------------------------------------
    // BILLING HISTORY
    // -----------------------------------------------------------------
    const findBillingHistory = (projectId, cycleDate) => {
        const monthStart = new Date(cycleDate.getFullYear(), cycleDate.getMonth(), 1);
        const monthEnd = new Date(cycleDate.getFullYear(), cycleDate.getMonth() + 1, 0);
        const results = search.create({
            type: RECORDS.BILLING_HISTORY,
            filters: [
                [FIELDS.HISTORY_PROJECT, 'anyof', projectId],
                'AND',
                [FIELDS.HISTORY_CYCLE_DATE, 'within',
                    format.format({ value: monthStart, type: format.Type.DATE }),
                    format.format({ value: monthEnd, type: format.Type.DATE })],
                'AND',
                ['isinactive', 'is', 'F']
            ],
            columns: [
                'internalid',
                FIELDS.HISTORY_STATUS,
                FIELDS.HISTORY_NO_BILL_REASON,
                FIELDS.HISTORY_RELATED_INVOICES,
                FIELDS.HISTORY_ACCOUNTING_NOTIFIED
            ]
        }).run().getRange({ start: 0, end: 2 }) || [];

        if (results.length > 1) {
            log.error('Duplicate billing history records', {
                projectId,
                cycleDate: ymd(cycleDate),
                recordIds: results.map((result) => result.id)
            });
        }

        if (!results.length) return null;

        const result = results[0];
        return {
            id: result.id,
            status: String(result.getValue({ name: FIELDS.HISTORY_STATUS }) || ''),
            statusText: result.getText({ name: FIELDS.HISTORY_STATUS }) || '',
            noBillReason: result.getValue({ name: FIELDS.HISTORY_NO_BILL_REASON }) || '',
            relatedInvoices: result.getValue({ name: FIELDS.HISTORY_RELATED_INVOICES }) || '',
            accountingNotified:
                result.getValue({ name: FIELDS.HISTORY_ACCOUNTING_NOTIFIED }) === true ||
                result.getValue({ name: FIELDS.HISTORY_ACCOUNTING_NOTIFIED }) === 'T'
        };
    };

    // -----------------------------------------------------------------
    // EMAIL HELPERS
    // -----------------------------------------------------------------
    const getFieldText = (fieldValue) => {
        if (!fieldValue) return '';
        if (Array.isArray(fieldValue)) {
            return fieldValue.map(getFieldText).filter(Boolean).join(', ');
        }
        if (typeof fieldValue === 'object') {
            return fieldValue.text || fieldValue.value || '';
        }
        return String(fieldValue);
    };

    const escapeHtml = (value) => String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const getApplicationBaseUrl = () => {
        const domain = url.resolveDomain({
            hostType: url.HostType.APPLICATION,
            accountId: runtime.accountId
        });
        return `https://${domain}`;
    };

    const getProjectUrl = (projectId) => {
        const relativeUrl = url.resolveRecord({
            recordType: RECORDS.PROJECT,
            recordId: projectId,
            isEditMode: false
        });
        return `${getApplicationBaseUrl()}${relativeUrl}`;
    };

    const getBillingHistoryTypeId = () => {
        if (billingHistoryTypeIdCache) return billingHistoryTypeIdCache;

        const results = search.create({
            type: 'customrecordtype',
            filters: [['scriptid', 'is', RECORDS.BILLING_HISTORY]],
            columns: ['internalid']
        }).run().getRange({ start: 0, end: 1 }) || [];

        if (!results.length) {
            throw new Error(
                `Unable to find the custom record type ${RECORDS.BILLING_HISTORY}`
            );
        }

        billingHistoryTypeIdCache = String(results[0].id);
        return billingHistoryTypeIdCache;
    };

    const getNoBillingEntryUrl = (projectId, cycleDate) => {
        try {
            const params = [
                `rectype=${encodeURIComponent(getBillingHistoryTypeId())}`,
                `${FIELDS.HISTORY_PROJECT}=${encodeURIComponent(projectId)}`,
                `${FIELDS.HISTORY_CYCLE_DATE}=${encodeURIComponent(format.format({
                    value: cycleDate,
                    type: format.Type.DATE
                }))}`,
                `${FIELDS.HISTORY_STATUS}=${encodeURIComponent(HISTORY_STATUS.NO_BILLING)}`
            ];

            return `${getApplicationBaseUrl()}/app/common/custom/custrecordentry.nl?${params.join('&')}`;
        } catch (error) {
            log.error('Unable to build No Billing entry link', {
                projectId,
                cycleDate: ymd(cycleDate),
                error: error.message
            });
            return '';
        }
    };

    const buildButton = (label, href, secondary) => {
        const background = secondary ? '#ffffff' : '#1769aa';
        const color = secondary ? '#1769aa' : '#ffffff';
        const border = secondary ? '1px solid #1769aa' : '1px solid #1769aa';

        return `<a href="${escapeHtml(href)}" style="display:inline-block;` +
            `margin:0 10px 10px 0;padding:11px 18px;background:${background};` +
            `color:${color};border:${border};border-radius:5px;text-decoration:none;` +
            `font-family:Arial,sans-serif;font-size:14px;font-weight:bold;">` +
            `${escapeHtml(label)}</a>`;
    };

    const buildEmailBody = ({
        heading,
        intro,
        details,
        message,
        actions,
        footer
    }) => {
        const detailRows = (details || []).filter((item) => item && item.value)
            .map((item) =>
                '<tr>' +
                `<td style="padding:5px 12px 5px 0;color:#667085;` +
                `font-size:13px;vertical-align:top;white-space:nowrap;">` +
                `${escapeHtml(item.label)}</td>` +
                `<td style="padding:5px 0;color:#101828;font-size:14px;` +
                `font-weight:600;vertical-align:top;">${escapeHtml(item.value)}</td>` +
                '</tr>'
            ).join('');
        const actionButtons = (actions || [])
            .filter((action) => action && action.href)
            .map((action) => buildButton(action.label, action.href, action.secondary))
            .join('');

        return '<div style="margin:0;padding:24px;background:#f4f7fb;">' +
            '<table role="presentation" cellpadding="0" cellspacing="0" ' +
            'style="width:100%;max-width:640px;margin:0 auto;background:#ffffff;' +
            'border:1px solid #e4e7ec;border-radius:8px;">' +
            '<tr><td style="height:5px;background:#1769aa;border-radius:8px 8px 0 0;"></td></tr>' +
            '<tr><td style="padding:28px 30px;font-family:Arial,sans-serif;">' +
            `<h2 style="margin:0 0 14px;color:#17324d;font-size:22px;line-height:1.3;">` +
            `${escapeHtml(heading)}</h2>` +
            `<p style="margin:0 0 18px;color:#344054;font-size:15px;line-height:1.6;">` +
            `${escapeHtml(intro)}</p>` +
            (detailRows
                ? `<table role="presentation" cellpadding="0" cellspacing="0" ` +
                    `style="margin:0 0 20px;">${detailRows}</table>`
                : '') +
            (message
                ? `<div style="margin:0 0 20px;padding:14px 16px;background:#f8fafc;` +
                    `border-left:4px solid #1769aa;color:#344054;font-size:14px;` +
                    `line-height:1.6;">${message}</div>`
                : '') +
            (actionButtons ? `<div style="margin-top:6px;">${actionButtons}</div>` : '') +
            (footer
                ? `<p style="margin:14px 0 0;color:#667085;font-size:12px;line-height:1.5;">` +
                    `${escapeHtml(footer)}</p>`
                : '') +
            '</td></tr></table></div>';
    };

    const sendProjectEmail = ({ audience, recipients, cc, subject, body, projectId }) => {
        if (!recipients || (Array.isArray(recipients) && recipients.length === 0)) {
            log.audit('Email skipped - no recipient', { audience, projectId, subject });
            return;
        }

        const options = {
            author: getSettings().emailSender,
            recipients,
            subject,
            body
        };
        if (cc && cc.length) options.cc = cc;

        email.send(options);
        log.audit('Billing email sent', {
            audience,
            projectId,
            recipients: Array.isArray(recipients) ? recipients.join(', ') : String(recipients),
            cc: cc || [],
            subject
        });
    };

    const getProjectContactEmails = (projectId, positionId, audience) => {
        const results = search.create({
            type: RECORDS.PROJECT_CONTACT,
            filters: [
                ['custrecord_bc_contact_project', 'anyof', projectId],
                'AND',
                ['custrecord_bc_position', 'anyof', positionId],
                'AND',
                ['custrecord_bc_contact_email', 'isnotempty', '']
            ],
            columns: ['custrecord_bc_contact_email']
        }).run().getRange({ start: 0, end: 1000 }) || [];

        const emails = results
            .map((result) => result.getValue({ name: 'custrecord_bc_contact_email' }))
            .filter(Boolean);

        log.debug('Project contacts loaded', {
            audience,
            projectId,
            positionId,
            count: emails.length
        });
        return emails;
    };

    const sendAccountingNotice = (projectId, subject, body) => {
        const settings = getSettings();

        sendProjectEmail({
            audience: 'Primary Accounting',
            recipients: settings.accountingEmail,
            cc: settings.accountingExtraEmails,
            subject,
            body,
            projectId
        });

        getProjectContactEmails(projectId, POSITIONS.ACCOUNTING, 'Project Accounting')
            .forEach((recipient) => {
                sendProjectEmail({
                    audience: 'Project Accounting',
                    recipients: recipient,
                    cc: settings.accountingExtraEmails,
                    subject,
                    body,
                    projectId
                });
            });
    };

    const notifyNoBillingOnce = (history, projectId, projectDisplay, cycleDate) => {
        if (!history ||
            history.status !== HISTORY_STATUS.NO_BILLING ||
            history.accountingNotified) {
            return;
        }

        const cycleDisplay = format.format({ value: cycleDate, type: format.Type.DATE });
        const projectUrl = getProjectUrl(projectId);
        sendAccountingNotice(
            projectId,
            `No billing this cycle - ${projectDisplay}`,
            buildEmailBody({
                heading: 'No Billing This Cycle',
                intro: 'The project team has confirmed that this project will not be billed for the current cycle.',
                details: [
                    { label: 'PROJECT', value: projectDisplay },
                    { label: 'BILL DATE', value: cycleDisplay },
                    {
                        label: 'REASON',
                        value: history.noBillReason || 'No reason was provided'
                    }
                ],
                actions: [
                    { label: 'View Project', href: projectUrl }
                ],
                footer: 'This is an automated billing notification.'
            })
        );

        record.submitFields({
            type: RECORDS.BILLING_HISTORY,
            id: history.id,
            values: {
                [FIELDS.HISTORY_ACCOUNTING_NOTIFIED]: true
            },
            options: {
                enableSourcing: false,
                ignoreMandatoryFields: true
            }
        });

        history.accountingNotified = true;
        log.audit('No Billing history notification completed', {
            historyId: history.id,
            projectId,
            cycleDate: ymd(cycleDate)
        });
    };

    const sendPmPreNotice = (
        mainPmId,
        mainPmName,
        projectId,
        projectDisplay,
        cycleDate
    ) => {
        const settings = getSettings();
        const cycleDisplay = format.format({ value: cycleDate, type: format.Type.DATE });
        const billMonth = `${[
            'January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'
        ][cycleDate.getMonth()]} ${cycleDate.getFullYear()}`;
        const projectUrl = getProjectUrl(projectId);
        const noBillingUrl = getNoBillingEntryUrl(projectId, cycleDate);

        sendProjectEmail({
            audience: 'Main PM',
            recipients: mainPmId,
            cc: settings.pmExtraEmails,
            subject: `Billing Due: ${cycleDisplay} - ${projectDisplay}`,
            body: buildEmailBody({
                heading: 'Billing Is Due',
                intro: `Billing is due for ${projectDisplay} on ${cycleDisplay}.`,
                details: [
                    { label: 'JOB', value: projectDisplay },
                    { label: 'BILL DATE', value: cycleDisplay },
                    { label: 'BILL MONTH', value: billMonth }
                ],
                message: `Open <strong>JB Progress Billing</strong> to create the bill. ` +
                    `Remember to update the <strong>Bill Month</strong> to ` +
                    `<strong>${escapeHtml(billMonth)}</strong>.`,
                actions: [
                    { label: 'Open JB Progress Billing', href: projectUrl },
                    {
                        label: 'Enter No Billing',
                        href: noBillingUrl,
                        secondary: true
                    }
                ],
                footer: 'Use “Enter No Billing” only when this job will not be billed for this cycle. The project, cycle date, and No Billing status will be prefilled.'
            }),
            projectId
        });

        getProjectContactEmails(projectId, POSITIONS.PHASE_PM, 'Phase PM')
            .forEach((recipient) => {
                const dueToPm = mainPmName || 'the Main PM';
                sendProjectEmail({
                    audience: 'Phase PM',
                    recipients: recipient,
                    cc: settings.pmExtraEmails,
                    subject: `Phase Billing Due to ${dueToPm} - ${projectDisplay}`,
                    body: buildEmailBody({
                        heading: 'Phase Billing Is Due',
                        intro: `Your phase billing is due to ${dueToPm} by ${cycleDisplay}.`,
                        details: [
                            { label: 'JOB', value: projectDisplay },
                            { label: 'BILL DATE', value: cycleDisplay },
                            { label: 'DUE TO', value: dueToPm }
                        ],
                        message: 'This project is billed through the <strong>Textura Payment Management system</strong>, as required by our customer. The schedule of values for your phase may differ in Textura, and the Main PM may require additional billing breakout.',
                        actions: [
                            { label: 'Open Project & SOV Details', href: projectUrl }
                        ],
                        footer: 'When requested, supply your job number.'
                    }),
                    projectId
                });
            });
    };

    const sendOverdueNotices = (mainPmId, projectId, projectDisplay, cycleDate) => {
        const settings = getSettings();
        const cycleDisplay = format.format({ value: cycleDate, type: format.Type.DATE });

        sendProjectEmail({
            audience: 'Main PM overdue',
            recipients: mainPmId,
            cc: settings.pmExtraEmails,
            subject: `REMINDER: billing decision required - ${projectDisplay}`,
            body: buildEmailBody({
                heading: 'Billing Decision Required',
                intro: 'The billing date has arrived and no billing decision has been recorded.',
                details: [
                    { label: 'PROJECT', value: projectDisplay },
                    { label: 'BILL DATE', value: cycleDisplay },
                    { label: 'STATUS', value: 'Billing history not entered' }
                ],
                message: 'Please create the bill now, or enter a No Billing record with the reason this project will not be billed.',
                actions: [
                    {
                        label: 'Open JB Progress Billing',
                        href: getProjectUrl(projectId)
                    },
                    {
                        label: 'Enter No Billing',
                        href: getNoBillingEntryUrl(projectId, cycleDate),
                        secondary: true
                    }
                ],
                footer: 'This reminder will continue until an Invoiced or No Billing history entry exists.'
            }),
            projectId
        });

        sendAccountingNotice(
            projectId,
            `REMINDER: no billing history yet - ${projectDisplay}`,
            buildEmailBody({
                heading: 'Billing History Is Still Outstanding',
                intro: 'No Invoiced or No Billing history entry has been recorded for this billing cycle.',
                details: [
                    { label: 'PROJECT', value: projectDisplay },
                    { label: 'BILL DATE', value: cycleDisplay },
                    { label: 'STATUS', value: 'Action required' }
                ],
                message: 'Please follow up with the Project Manager, or create the invoice if billing is ready.',
                actions: [
                    { label: 'Review Project', href: getProjectUrl(projectId) }
                ],
                footer: 'This is an automated billing follow-up.'
            })
        );
    };

    const backfillInvoicedHistory = (projectId, cycleDate) => {
        const monthStart = new Date(cycleDate.getFullYear(), cycleDate.getMonth(), 1);
        const monthEnd = new Date(cycleDate.getFullYear(), cycleDate.getMonth() + 1, 0);
        const invoiceIds = [];

        search.create({
            type: 'invoice',
            filters: [
                ['mainline', 'is', 'T'],
                'AND',
                [FIELDS.PROJECT_SEGMENT, 'anyof', projectId],
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

        log.debug('Recent-cycle invoice fallback check', {
            projectId,
            cycleDate: ymd(cycleDate),
            monthStart: ymd(monthStart),
            monthEnd: ymd(monthEnd),
            invoiceIds
        });

        if (!invoiceIds.length) return null;

        const historyRecord = record.create({
            type: RECORDS.BILLING_HISTORY,
            isDynamic: false
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
            fieldId: FIELDS.HISTORY_STATUS,
            value: HISTORY_STATUS.INVOICED
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
            ignoreMandatoryFields: true
        });

        log.audit('Recent-cycle Billing History backfilled from invoices', {
            historyId,
            projectId,
            cycleDate: ymd(cycleDate),
            invoiceIds
        });

        return historyId;
    };

    // -----------------------------------------------------------------
    // MAP/REDUCE ENTRY POINTS
    // -----------------------------------------------------------------
    const getInputData = () => {
        const settings = getSettings();
        const currentDate = getCurrentDate();

        log.audit('Billing notifications started', {
            effectiveCurrentDate: ymd(currentDate),
            testMode: Boolean(settings.testCurrentDate),
            daysBeforePm: settings.daysBeforePm,
            daysBeforeAccounting: settings.daysBeforeAccounting
        });

        if (settings.testCurrentDate) {
            log.audit('TEST DATE OVERRIDE ACTIVE', {
                effectiveCurrentDate: ymd(currentDate),
                parameterId: PARAMS.TEST_CURRENT_DATE
            });
        }

      const openChangeProjectIds = getOpenChangeOrderProjectIds();

const openChangeProjectFilter = buildAnyOfFilterExpression(
    'internalid',
    openChangeProjectIds
);

const contractNotBilledFilter = [
    `${FIELDS.CONTRACT_SALES_ORDER}.status`,
    'noneof',
    [SALES_ORDER_STATUSES.BILLED, SALES_ORDER_STATUSES.CLOSED]
];

const billingQualificationFilter = openChangeProjectFilter
    ? [contractNotBilledFilter, 'OR', openChangeProjectFilter]
    : contractNotBilledFilter;

        return search.create({
            type: RECORDS.PROJECT,
            filters: [
                ['internalid', 'anyof', '67126'],
                'AND',
                ['custrecord_bc_proj_subsidiary', 'anyof', SUBSIDIARIES.BLUECOLLAR],
                'AND',
                ['isinactive', 'is', 'F'],
                'AND',
                [FIELDS.BILL_DATE, 'noneof', '@NONE@'],
                'AND',
                [FIELDS.CONTRACT_SALES_ORDER, 'noneof', '@NONE@'],
                'AND',
                billingQualificationFilter
            ],
            columns: [
                'internalid',
                FIELDS.PROJECT_DISPLAY,
                FIELDS.BILL_DATE,
                FIELDS.MAIN_PM,
                FIELDS.CONTRACT_SALES_ORDER
            ]
        });
    };

    const map = (context) => {
        try {
            const result = JSON.parse(context.value);
            const values = result.values;
            const projectId = result.id;
            const projectDisplay = getFieldText(values[FIELDS.PROJECT_DISPLAY]) ||
                'Project name unavailable';
            const billField = values[FIELDS.BILL_DATE];
            const billText = billField && billField.text ? billField.text : null;

            if (!billText) {
                log.audit('Project skipped - no bill day', { projectId, projectDisplay });
                return;
            }

            const settings = getSettings();
            const now = getCurrentDate();
            const holidays = getHolidays(now);
            const billDates = getBillDates(billText, now);
            const upcoming = billDates.upcoming;
            const recent = billDates.recent;
            const pmTriggerDate = subtractBusinessDays(
                upcoming,
                settings.daysBeforePm,
                holidays
            );
            const accountingTriggerDate = subtractBusinessDays(
                upcoming,
                settings.daysBeforeAccounting,
                holidays
            );
            const mainPmField = values[FIELDS.MAIN_PM];
            const mainPmId = mainPmField && mainPmField.value ? mainPmField.value : null;
            const mainPmName = getFieldText(mainPmField) || 'Main PM';
            const sameCycle = sameMonth(upcoming, recent);

            log.debug('Project billing evaluation', {
                projectId,
                projectDisplay,
                billDay: billText,
                today: ymd(now),
                upcomingBillDate: ymd(upcoming),
                recentBillDate: ymd(recent),
                pmTriggerDate: ymd(pmTriggerDate),
                accountingTriggerDate: ymd(accountingTriggerDate),
                mainPmId: mainPmId || '(none)'
            });

            // Before the bill date, notices repeat every run after each threshold
            // until a No Billing or Invoiced child history record exists.
            if (now < upcoming) {
                const upcomingHistory = findBillingHistory(projectId, upcoming);

                if (upcomingHistory) {
                    log.audit('Upcoming-cycle notices stopped by billing history', {
                        projectId,
                        cycleDate: ymd(upcoming),
                        historyId: upcomingHistory.id,
                        status: upcomingHistory.statusText || upcomingHistory.status
                    });
                    notifyNoBillingOnce(
                        upcomingHistory,
                        projectId,
                        projectDisplay,
                        upcoming
                    );
                } else if (backfillInvoicedHistory(projectId, upcoming)) {
                    log.audit('Upcoming-cycle notices stopped after history backfill', {
                        projectId,
                        cycleDate: ymd(upcoming)
                    });
                } else {
                    if (now >= pmTriggerDate) {
                        log.audit('Daily PM notice window active', {
                            projectId,
                            cycleDate: ymd(upcoming)
                        });
                        sendPmPreNotice(
                            mainPmId,
                            mainPmName,
                            projectId,
                            projectDisplay,
                            upcoming
                        );
                    }

                    if (now >= accountingTriggerDate) {
                        log.audit('Daily Accounting notice window active', {
                            projectId,
                            cycleDate: ymd(upcoming)
                        });
                        sendAccountingNotice(
                            projectId,
                            `Invoice creation approaching - ${projectDisplay}`,
                            buildEmailBody({
                                heading: 'Invoice Creation Is Approaching',
                                intro: 'The project billing date is approaching and no billing history has been entered.',
                                details: [
                                    { label: 'PROJECT', value: projectDisplay },
                                    {
                                        label: 'BILL DATE',
                                        value: format.format({
                                            value: upcoming,
                                            type: format.Type.DATE
                                        })
                                    },
                                    { label: 'STATUS', value: 'Ready for review' }
                                ],
                                message: 'Please review the billing details and create the invoice when billing is ready.',
                                actions: [
                                    {
                                        label: 'Review Project',
                                        href: getProjectUrl(projectId)
                                    }
                                ],
                                footer: 'This is an automated advance billing notification.'
                            })
                        );
                    }
                }
            }

            // The recent cycle remains open until a history record exists.
            // On and after its bill date, reminders repeat every run.
            if (!sameCycle || now >= recent) {
                const recentHistory = findBillingHistory(projectId, recent);

                if (recentHistory) {
                    log.audit('Recent-cycle reminders stopped by billing history', {
                        projectId,
                        cycleDate: ymd(recent),
                        historyId: recentHistory.id,
                        status: recentHistory.statusText || recentHistory.status
                    });
                    notifyNoBillingOnce(
                        recentHistory,
                        projectId,
                        projectDisplay,
                        recent
                    );
                } else if (backfillInvoicedHistory(projectId, recent)) {
                    log.audit('Recent-cycle reminders stopped after history backfill', {
                        projectId,
                        cycleDate: ymd(recent)
                    });
                } else if (now >= recent) {
                    log.audit('Daily overdue reminder window active', {
                        projectId,
                        cycleDate: ymd(recent)
                    });
                    sendOverdueNotices(
                        mainPmId,
                        projectId,
                        projectDisplay,
                        recent
                    );
                }
            }
        } catch (error) {
            log.error('Map error', {
                key: context.key,
                name: error.name,
                message: error.message,
                stack: error.stack
            });
        }
    };

    const summarize = (summary) => {
        if (summary.inputSummary.error) {
            log.error('Input stage error', summary.inputSummary.error);
        }

        summary.mapSummary.errors.iterator().each((key, error) => {
            log.error('Map stage error', { key, error });
            return true;
        });

        log.audit('Billing notifications completed', {
            usage: summary.usage,
            concurrency: summary.concurrency,
            yields: summary.yields,
            seconds: summary.seconds
        });
    };

    return { getInputData, map, summarize };
});
