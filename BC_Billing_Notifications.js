/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define([
    'N/search',
    'N/email',
    'N/format',
    'N/log',
    'N/url',
    'N/runtime'
], (search, email, format, log, url, runtime) => {

    const PARAMS = {
        DAYS_BEFORE_PM: 'custscript_bc_bn_days_before_pm',
        DAYS_BEFORE_ACCOUNTING: 'custscript_bc_bn_days_before_acc',
        EMAIL_SENDER: 'custscript_bc_bn_email_sender',
        PM_EXTRA_EMAILS: 'custscript_bc_bn_pm_extra_emails',
        ACCOUNTING_EXTRA_EMAILS: 'custscript_bc_bn_acc_extra_emails',
        ACCOUNTING_EMAIL: 'custscript_bc_bn_accounting_email',
        TEST_CURRENT_DATE: 'custscript_bc_bn_test_current_date'
    };

    // Preserve the current behavior when a deployment parameter is blank.
    const DEFAULTS = {
        DAYS_BEFORE_PM: 3,
        DAYS_BEFORE_ACCOUNTING: 1,
        EMAIL_SENDER: -5,
        PM_EXTRA_EMAILS: ['jainil.suthar@bluecollar.cloud'],
        ACCOUNTING_EXTRA_EMAILS: ['jainil.suthar@bluecollar.cloud'],
        ACCOUNTING_EMAIL: 697221
    };

    const FIELDS = {
        PROJECT_DISPLAY: 'name',
        MAIN_PM: 'custrecord_bc_proj_manager',
        BILL_DATE: 'custrecord_bill_date',
        NO_BILL: 'custrecord_bc_no_bill',
        NO_BILL_REASON: 'custrecord_bc_no_bill_reason',
        NO_BILL_DATE: 'custrecord_bc_no_bill_date',
        PROJECT_SEGMENT: 'cseg_bc_project'
    };

    const RECORDS = {
        PROJECT: 'customrecord_cseg_bc_project',
        PROJECT_CONTACT: 'customrecord_bc_project_contact_list',
        HOLIDAY: 'customrecord_bc_holiday_list'
    };

    const POSITIONS = {
        PHASE_PM: '3',
        ACCOUNTING: '4'
    };

    let settingsCache = null;
    let holidayCache = null;

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

    const parseDateParameter = (value, parameterId) => {
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
            log.error('Invalid date parameter - using actual current date', {
                parameterId,
                suppliedValue: value,
                error: error.message
            });
            return null;
        }
    };

    const getSettings = () => {
        if (settingsCache) return settingsCache;

        const script = runtime.getCurrentScript();
        const testCurrentDate = parseDateParameter(
            script.getParameter({ name: PARAMS.TEST_CURRENT_DATE }),
            PARAMS.TEST_CURRENT_DATE
        );

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
            testCurrentDate
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
    // DATE AND BILL-CYCLE HELPERS
    // -----------------------------------------------------------------
    const stripTime = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

    const getCurrentDate = () => {
        const testCurrentDate = getSettings().testCurrentDate;
        return testCurrentDate
            ? stripTime(new Date(testCurrentDate.getTime()))
            : stripTime(new Date());
    };

    const ymd = (date) => {
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${date.getFullYear()}-${month}-${day}`;
    };

    const sameDay = (first, second) => ymd(first) === ymd(second);

    const sameMonth = (first, second) => {
        return Boolean(first && second) &&
            first.getFullYear() === second.getFullYear() &&
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
                const date = format.parse({ value, type: format.Type.DATE });
                holidayCache.add(ymd(date));
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

    const buildEmailBody = (lines, projectId) => {
        const relativeUrl = url.resolveRecord({
            recordType: RECORDS.PROJECT,
            recordId: projectId,
            isEditMode: false
        });
        const domain = url.resolveDomain({
            hostType: url.HostType.APPLICATION,
            accountId: runtime.accountId
        });

        return lines.filter(Boolean).join('<br>') +
            `<br><br><a href="https://${domain}${relativeUrl}">View Project</a>`;
    };

    const sendProjectEmail = ({ audience, recipients, cc, subject, lines, projectId }) => {
        if (!recipients || (Array.isArray(recipients) && recipients.length === 0)) {
            log.audit('Email skipped - no recipient', { audience, projectId, subject });
            return;
        }

        const options = {
            author: getSettings().emailSender,
            recipients,
            subject,
            body: buildEmailBody(lines, projectId)
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
            count: emails.length,
            emails
        });

        return emails;
    };

    // The primary Accounting employee and every project Accounting contact
    // receive separate emails, matching the existing behavior.
    const sendAccountingNotice = (projectId, subject, lines) => {
        const settings = getSettings();

        sendProjectEmail({
            audience: 'Primary Accounting',
            recipients: settings.accountingEmail,
            cc: settings.accountingExtraEmails,
            subject,
            lines,
            projectId
        });

        getProjectContactEmails(projectId, POSITIONS.ACCOUNTING, 'Project Accounting')
            .forEach((recipient) => {
                sendProjectEmail({
                    audience: 'Project Accounting',
                    recipients: recipient,
                    cc: settings.accountingExtraEmails,
                    subject,
                    lines,
                    projectId
                });
            });
    };

    // -----------------------------------------------------------------
    // INVOICE CHECK
    // -----------------------------------------------------------------
    const invoiceExistsInCycle = (projectId, billDate) => {
        const monthStart = new Date(billDate.getFullYear(), billDate.getMonth(), 1);
        const monthEnd = new Date(billDate.getFullYear(), billDate.getMonth() + 1, 0);

        const count = search.create({
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
        }).runPaged().count;

        log.debug('Invoice cycle check', {
            projectId,
            monthStart: ymd(monthStart),
            monthEnd: ymd(monthEnd),
            invoiceCount: count
        });

        return count > 0;
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

        return search.create({
            type: RECORDS.PROJECT,
            filters: [
                ['internalid', 'anyof', '67126'],
                'AND',
                ['custrecord_bc_proj_subsidiary', 'anyof', '23'],
                'AND',
                ['isinactive', 'is', 'F'],
                'AND',
                [FIELDS.BILL_DATE, 'noneof', '@NONE@']
            ],
            columns: [
                'internalid',
                FIELDS.PROJECT_DISPLAY,
                FIELDS.BILL_DATE,
                FIELDS.MAIN_PM,
                FIELDS.NO_BILL,
                FIELDS.NO_BILL_REASON,
                FIELDS.NO_BILL_DATE
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
            const noBill = values[FIELDS.NO_BILL] === true || values[FIELDS.NO_BILL] === 'T';
            const noBillDateRaw = values[FIELDS.NO_BILL_DATE];
            const noBillDate = noBillDateRaw
                ? stripTime(format.parse({ value: noBillDateRaw, type: format.Type.DATE }))
                : null;
            const noBillThisMonth = noBill && sameMonth(noBillDate, now);
            const noBillForUpcomingMonth = noBill && sameMonth(noBillDate, upcoming);

            const upcomingDisplay = format.format({ value: upcoming, type: format.Type.DATE });
            const recentDisplay = format.format({ value: recent, type: format.Type.DATE });

            log.debug('Project billing evaluation', {
                projectId,
                projectDisplay,
                billDay: billText,
                today: ymd(now),
                upcomingBillDate: ymd(upcoming),
                recentBillDate: ymd(recent),
                pmTriggerDate: ymd(pmTriggerDate),
                accountingTriggerDate: ymd(accountingTriggerDate),
                mainPmId: mainPmId || '(none)',
                noBill,
                noBillDate: noBillDate ? ymd(noBillDate) : '(none)',
                noBillThisMonth,
                noBillForUpcomingMonth
            });

            if (sameDay(now, pmTriggerDate)) {
                if (noBillThisMonth) {
                    log.audit('PM notice skipped - no bill this month', {
                        projectId,
                        noBillDate: ymd(noBillDate)
                    });
                } else {
                    log.audit('PM notice trigger hit', { projectId, triggerDate: ymd(now) });

                    sendProjectEmail({
                        audience: 'Main PM',
                        recipients: mainPmId,
                        cc: settings.pmExtraEmails,
                        subject: `Billing due ${upcomingDisplay} - ${projectDisplay}`,
                        lines: [
                            `Project: ${projectDisplay}`,
                            `Bill Date: ${upcomingDisplay}`,
                            'Status: Billing is coming due.',
                            'Action Needed: Please prepare the billing package and submit the invoice or schedule of values before the bill date.',
                            'If this project should not be billed this cycle, mark it as No Bill and enter the no-bill reason/date.'
                        ],
                        projectId
                    });

                    getProjectContactEmails(projectId, POSITIONS.PHASE_PM, 'Phase PM')
                        .forEach((recipient) => {
                            sendProjectEmail({
                                audience: 'Phase PM',
                                recipients: recipient,
                                cc: settings.pmExtraEmails,
                                subject: `Action needed: submit schedule of values - ${projectDisplay}`,
                                lines: [
                                    `Project: ${projectDisplay}`,
                                    `Bill Date: ${upcomingDisplay}`,
                                    'Action Needed: Please submit your schedule of values to the Main PM so billing can be prepared.'
                                ],
                                projectId
                            });
                        });
                }
            }

            if (sameDay(now, accountingTriggerDate)) {
                if (noBillForUpcomingMonth) {
                    log.audit('Accounting pre-notice skipped - no bill for upcoming month', {
                        projectId,
                        noBillDate: ymd(noBillDate),
                        upcomingBillDate: ymd(upcoming)
                    });
                } else {
                    log.audit('Accounting pre-notice trigger hit', {
                        projectId,
                        triggerDate: ymd(now)
                    });
                    sendAccountingNotice(
                        projectId,
                        `Invoice creation due tomorrow - ${projectDisplay}`,
                        [
                            `Project: ${projectDisplay}`,
                            `Bill Date: ${upcomingDisplay}`,
                            'Status: Billing is due tomorrow.',
                            'Action Needed: Please review the billing details and create the invoice if billing is ready.'
                        ]
                    );
                }
            }

            // A no-bill date matching the most recent bill date notifies
            // Accounting and ends processing for this project.
            if (noBill && noBillDate && sameDay(noBillDate, recent)) {
                const reason = getFieldText(values[FIELDS.NO_BILL_REASON]) ||
                    '(no reason provided)';

                log.audit('No-bill notification trigger hit', {
                    projectId,
                    billDate: ymd(recent),
                    reason
                });
                sendAccountingNotice(
                    projectId,
                    `No billing this cycle - ${projectDisplay}`,
                    [
                        `Project: ${projectDisplay}`,
                        `Bill Date: ${recentDisplay}`,
                        'Status: The PM marked this project as no-billing for this cycle.',
                        `Reason: ${reason}`
                    ]
                );
                return;
            }

            const hasInvoice = invoiceExistsInCycle(projectId, recent);
            if (!hasInvoice) {
                if (noBillThisMonth) {
                    log.audit('Overdue reminders skipped - no bill this month', {
                        projectId,
                        noBillDate: ymd(noBillDate)
                    });
                } else {
                    log.audit('Overdue reminder trigger hit', {
                        projectId,
                        billDate: ymd(recent)
                    });
                    sendProjectEmail({
                        audience: 'Main PM reminder',
                        recipients: mainPmId,
                        cc: settings.pmExtraEmails,
                        subject: `REMINDER: billing due - ${projectDisplay}`,
                        lines: [
                            `Project: ${projectDisplay}`,
                            `Bill Date: ${recentDisplay}`,
                            'Status: No invoice has been found for this billing cycle.',
                            'Action Needed: Please submit the invoice or update the project No Bill information if billing will not occur this cycle.'
                        ],
                        projectId
                    });
                    sendAccountingNotice(
                        projectId,
                        `REMINDER: no invoice yet - ${projectDisplay}`,
                        [
                            `Project: ${projectDisplay}`,
                            `Bill Date: ${recentDisplay}`,
                            'Status: No invoice has been found for this billing cycle.',
                            'Action Needed: Please follow up with the PM or create the invoice if billing is ready.'
                        ]
                    );
                }
            } else {
                log.debug('No reminder required - invoice found', {
                    projectId,
                    billDate: ymd(recent)
                });
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