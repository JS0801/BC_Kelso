/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/search', 'N/record', 'N/email', 'N/format', 'N/log'],
(search, record, email, format, log) => {

    // ---------------------------------------------------------------
    // CONFIG  (change these, not the logic below)
    // ---------------------------------------------------------------
    const CONFIG = {
        DAYS_BEFORE_PM: 3,          // working days before Bill Date -> PMs
        DAYS_BEFORE_ACCOUNTING: 1,  // working days before Bill Date -> Accounting
        ACCOUNTING_EMAIL: 'sean.bartlett@apg.company',
        EMAIL_AUTHOR_ID: -5,        // internal id of the employee the email is "from". -5 = system. Set to a real employee if desired.
        PROJECT_SEGMENT_FIELD: 'cseg_bc_project', // segment field on the invoice transaction
        PROJECT_DISPLAY_FIELD: 'name', // project name/number shown in email subjects and bodies

        // Project (customrecord_cseg_bc_project) header fields
        FIELD_MAIN_PM: 'custrecord_bc_proj_manager',
        FIELD_BILL_DATE: 'custrecord_bill_date', // LIST field: text = day of month ('1'..'30') or 'EOM'
        FIELD_NO_BILL: 'custrecord_bc_no_bill',
        FIELD_NO_BILL_REASON: 'custrecord_bc_no_bill_reason',
        FIELD_NO_BILL_DATE: 'custrecord_bc_no_bill_date',

        PHASE_PM_POSITION: '3',      // custrecord_bc_position value for Phase PM
        ACCOUNTING_POSITION: '4'
    };

    // Holidays: empty for now. Add 'YYYY-MM-DD' strings here, OR replace
    // getHolidays() with a search of a holiday custom record later.
    const HOLIDAYS = [
        // '2026-07-03',
    ];
    const getHolidays = () => new Set(HOLIDAYS);

    // ---------------------------------------------------------------
    // DATE HELPERS
    // ---------------------------------------------------------------
    const stripTime = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const today = () => stripTime(new Date());

    const ymd = (d) => {
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${d.getFullYear()}-${m}-${day}`;
    };
    const sameDay = (a, b) => ymd(a) === ymd(b);

    const isBusinessDay = (d, holidaySet) => {
        const dow = d.getDay();              // 0 = Sun, 6 = Sat
        if (dow === 0 || dow === 6) return false;
        if (holidaySet.has(ymd(d))) return false;
        return true;
    };

    // Subtract N business days from a date (skipping weekends + holidays).
    const subtractBusinessDays = (date, n, holidaySet) => {
        const d = stripTime(date);
        let remaining = n;
        while (remaining > 0) {
            d.setDate(d.getDate() - 1);
            if (isBusinessDay(d, holidaySet)) remaining--;
        }
        return d;
    };

    // ---------------------------------------------------------------
    // BILL DAY HELPERS
    // custrecord_bill_date is a LIST field. Its TEXT is the day of month
    // ('1'..'30') or 'EOM'. We compute the actual calendar date per cycle.
    // (No '31' exists in the list -> the 31st is represented by EOM.)
    // ---------------------------------------------------------------
    const lastDayOfMonth = (year, month) => new Date(year, month + 1, 0).getDate();

    // Build the bill date for a given year/month from the picklist text.
    const billDateForMonth = (billText, year, month) => {
        if (String(billText).toUpperCase() === 'EOM') {
            return new Date(year, month, lastDayOfMonth(year, month));
        }
        const day = parseInt(billText, 10);
        const capped = Math.min(day, lastDayOfMonth(year, month)); // safety, e.g. day 30 in Feb
        return new Date(year, month, capped);
    };

    // Next occurrence on/after today (drives the "before" pre-notices).
    const upcomingBillDate = (billText, ref) => {
        const thisMonth = billDateForMonth(billText, ref.getFullYear(), ref.getMonth());
        if (thisMonth >= ref) return thisMonth;
        return billDateForMonth(billText, ref.getFullYear(), ref.getMonth() + 1);
    };

    // Most recent occurrence on/before today (drives overdue reminders + cycle window).
    const recentBillDate = (billText, ref) => {
        const thisMonth = billDateForMonth(billText, ref.getFullYear(), ref.getMonth());
        if (thisMonth <= ref) return thisMonth;
        return billDateForMonth(billText, ref.getFullYear(), ref.getMonth() - 1);
    };

    // ---------------------------------------------------------------
    // 1) INPUT: active projects that have a Bill Date
    // ---------------------------------------------------------------
    const getInputData = () => {
        log.audit('Billing notifications run START', 'today=' + ymd(today()));

      try {
        return search.create({
            type: 'customrecord_cseg_bc_project',
            filters: [
                ['internalid', 'anyof', '67126'],
                'AND',
                ['custrecord_bc_proj_subsidiary', 'anyof', '23'],
                'AND',
                ['isinactive', 'is', 'F'],
                'AND',
                [CONFIG.FIELD_BILL_DATE, 'noneof', '@NONE@']
            ],
            columns: [
                'internalid',
                CONFIG.PROJECT_DISPLAY_FIELD,
                CONFIG.FIELD_BILL_DATE,
                CONFIG.FIELD_MAIN_PM,
                CONFIG.FIELD_NO_BILL,
                CONFIG.FIELD_NO_BILL_REASON,
                CONFIG.FIELD_NO_BILL_DATE
            ]
        });
      } catch (error) {
        log.error('GET - Error', error)
      }
        
    };

    // ---------------------------------------------------------------
    // 2) MAP: decide and send for one project
    // ---------------------------------------------------------------
    const map = (context) => {
        try {
            const r = JSON.parse(context.value);
            const v = r.values;

            const projectId = r.id;
            const projectDisplay = getProjectDisplay(v);

            // Bill day comes from the LIST field's TEXT ('1'..'30' or 'EOM').
            const billField = v[CONFIG.FIELD_BILL_DATE];
            const billText = billField && billField.text ? billField.text : null;
            if (!billText) {
                log.audit('No bill day set', 'project ' + projectId);
                return;
            }

            // PM field comes back as { value: id, text: name }
            const pmField = v[CONFIG.FIELD_MAIN_PM];
            const mainPmId = pmField && pmField.value ? pmField.value : null;

            const holidaySet = getHolidays();
            const now = today();

            // Upcoming occurrence drives the "before" notices; most-recent
            // occurrence drives overdue reminders + the invoice cycle window.
            const upcoming = upcomingBillDate(billText, now);
            log.debug('Project Dates', {projectId,  billText, now, upcoming})
            const recent = recentBillDate(billText, now);

            const pmTriggerDate = subtractBusinessDays(upcoming, CONFIG.DAYS_BEFORE_PM, holidaySet);
            const acctTriggerDate = subtractBusinessDays(upcoming, CONFIG.DAYS_BEFORE_ACCOUNTING, holidaySet);

            const upcomingDisplay = format.format({ value: upcoming, type: format.Type.DATE });
            const recentDisplay = format.format({ value: recent, type: format.Type.DATE });

            // Diagnostic snapshot for every project, every run.
            log.debug('Evaluating project ' + projectId, {
                today: ymd(now),
                billDay: billText,
                upcoming: ymd(upcoming),
                recent: ymd(recent),
                pmTriggerDate: ymd(pmTriggerDate),
                acctTriggerDate: ymd(acctTriggerDate),
                mainPmId: mainPmId,
                projectDisplay: projectDisplay
            });

            // --- 3 working days before upcoming bill date: notify PMs ---
            if (sameDay(now, pmTriggerDate)) {
                log.audit('PM trigger HIT', 'project ' + projectId + ' (' + ymd(now) + ')');
                notifyMainPm(mainPmId, projectId, projectDisplay, upcomingDisplay);
                notifyPhasePms(projectId, projectDisplay, upcomingDisplay);
            }

            // --- 1 working day before upcoming bill date: notify Accounting ---
            if (sameDay(now, acctTriggerDate)) {
                log.audit('Accounting trigger HIT', 'project ' + projectId + ' (' + ymd(now) + ')');
                sendAccounting(
                    `Invoice creation due tomorrow - ${projectDisplay}`,
                    emailBody([
                        `Project: ${projectDisplay}`,
                        `Bill Date: ${upcomingDisplay}`,
                        'Status: Billing is due tomorrow.',
                        'Action Needed: Please review the billing details and create the invoice if billing is ready.'
                    ])
                );
                notifyAccountingContacts(
                    `Invoice creation due tomorrow - ${projectDisplay}`,
                    emailBody([
                        `Project: ${projectDisplay}`,
                        `Bill Date: ${upcomingDisplay}`,
                        'Status: Billing is due tomorrow.',
                        'Action Needed: Please review the billing details and create the invoice if billing is ready.'
                    ])
                );
            }

            // --- On/after the most recent bill date: reminders / no-bill handling ---
            // (recent is always <= today, so this cycle's bill day has passed.)
            {
                const noBill = v[CONFIG.FIELD_NO_BILL] === true || v[CONFIG.FIELD_NO_BILL] === 'T';
                const noBillDateRaw = v[CONFIG.FIELD_NO_BILL_DATE];
                const noBillDate = noBillDateRaw
                    ? stripTime(format.parse({ value: noBillDateRaw, type: format.Type.DATE }))
                    : null;

                // Checkbox set and applies to THIS cycle -> tell Accounting once, then stop.
                if (noBill && noBillDate && sameDay(noBillDate, recent)) {
                    const reason = getFieldText(v[CONFIG.FIELD_NO_BILL_REASON]) || '(no reason provided)';
                    log.audit('No-bill flagged', 'project ' + projectId + ' reason: ' + reason);
                    sendAccounting(
                        `No billing this cycle - ${projectDisplay}`,
                        emailBody([
                            `Project: ${projectDisplay}`,
                            `Bill Date: ${recentDisplay}`,
                            'Status: The PM marked this project as no-billing for this cycle.',
                            `Reason: ${reason}`
                        ])
                    );
                    notifyAccountingContacts(
                        `No billing this cycle - ${projectDisplay}`,
                        emailBody([
                            `Project: ${projectDisplay}`,
                            `Bill Date: ${recentDisplay}`,
                            'Status: The PM marked this project as no-billing for this cycle.',
                            `Reason: ${reason}`
                        ])
                    );
                    // NOTE: to truly send this only ONCE (not daily), add a
                    // "no-bill notified" flag field and check/set it here.
                    return;
                }

                // Otherwise, if no invoice exists in this cycle, daily reminder.
                const hasInvoice = invoiceExistsInCycle(projectId, recent);
                log.debug('Invoice check', 'project ' + projectId + ' hasInvoice=' + hasInvoice);
                if (!hasInvoice) {
                    log.audit('Reminder SENT', 'project ' + projectId + ' (no invoice in cycle)');
                    notifyMainPm(mainPmId, projectId, projectDisplay, recentDisplay, true);
                    sendAccounting(
                        `REMINDER: no invoice yet - ${projectDisplay}`,
                        emailBody([
                            `Project: ${projectDisplay}`,
                            `Bill Date: ${recentDisplay}`,
                            'Status: No invoice has been found for this billing cycle.',
                            'Action Needed: Please follow up with the PM or create the invoice if billing is ready.'
                        ])
                    );
                    notifyAccountingContacts(
                        `REMINDER: no invoice yet - ${projectDisplay}`,
                        emailBody([
                            `Project: ${projectDisplay}`,
                            `Bill Date: ${recentDisplay}`,
                            'Status: No invoice has been found for this billing cycle.',
                            'Action Needed: Please follow up with the PM or create the invoice if billing is ready.'
                        ])
                    );
                }
            }
        } catch (e) {
            log.error('map error - project ' + context.key, e);
        }
    };

    // ---------------------------------------------------------------
    // EMAIL HELPERS
    // ---------------------------------------------------------------
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

    const getProjectDisplay = (values) => {
        return getFieldText(values[CONFIG.PROJECT_DISPLAY_FIELD]) || 'Project name unavailable';
    };

    const emailBody = (lines) => lines.filter(Boolean).join('\n');

    const notifyMainPm = (pmId, projectId, projectDisplay, billDisplay, isReminder) => {
        if (!pmId) {
            log.audit('No Main PM set', 'project ' + projectId);
            return;
        }
        const subject = isReminder
            ? `REMINDER: billing due - ${projectDisplay}`
            : `Billing due ${billDisplay} - ${projectDisplay}`;
        const body = isReminder
            ? emailBody([
                `Project: ${projectDisplay}`,
                `Bill Date: ${billDisplay}`,
                'Status: No invoice has been found for this billing cycle.',
                'Action Needed: Please submit the invoice or update the project No Bill information if billing will not occur this cycle.'
            ])
            : emailBody([
                `Project: ${projectDisplay}`,
                `Bill Date: ${billDisplay}`,
                'Status: Billing is coming due.',
                'Action Needed: Please prepare the billing package and submit the invoice or schedule of values before the bill date.',
                'If this project should not be billed this cycle, mark it as No Bill and enter the no-bill reason/date.'
            ]);
        email.send({
            author: CONFIG.EMAIL_AUTHOR_ID,
            recipients: pmId,        // employee internal id; NetSuite resolves the address
            cc: ['jainil.suthar@bluecollar.cloud'],
            subject,
            body
        });
        log.audit('Email -> Main PM', 'project ' + projectId + ' pmId=' + pmId + ' subject="' + subject + '"');
    };

    const notifyPhasePms = (projectId, projectDisplay, billDisplay) => {
        const results = search.create({
            type: 'customrecord_bc_project_contact_list',
            filters: [
                ['custrecord_bc_contact_project', 'anyof', projectId],
                'AND',
                ['custrecord_bc_position', 'anyof', CONFIG.PHASE_PM_POSITION],
                'AND',
                ['custrecord_bc_contact_email', 'isnotempty', '']
            ],
            columns: ['custrecord_bc_contact_email', 'custrecord_bc_contact_name']
        }).run().getRange({ start: 0, end: 1000 }) || [];

        log.debug('Phase PMs found', 'project ' + projectId + ' count=' + results.length);
        results.forEach((res) => {
            const addr = res.getValue('custrecord_bc_contact_email');
            if (!addr) return;
            email.send({
                author: CONFIG.EMAIL_AUTHOR_ID,
                recipients: addr,
                subject: `Action needed: submit schedule of values - ${projectDisplay}`,
                cc: ['jainil.suthar@bluecollar.cloud'],
                body: emailBody([
                    `Project: ${projectDisplay}`,
                    `Bill Date: ${billDisplay}`,
                    'Action Needed: Please submit your schedule of values to the Main PM so billing can be prepared.'
                ])
            });
            log.audit('Email -> Phase PM', 'project ' + projectId + ' to=' + addr);
        });
    };

    const notifyAccountingContacts = (projectId, projectDisplay, subject, body) => {
    const results = search.create({
        type: 'customrecord_bc_project_contact_list',
        filters: [
            ['custrecord_bc_contact_project', 'anyof', projectId],
            'AND',
            ['custrecord_bc_position', 'anyof', CONFIG.ACCOUNTING_POSITION],
            'AND',
            ['custrecord_bc_contact_email', 'isnotempty', '']
        ],
        columns: ['custrecord_bc_contact_email', 'custrecord_bc_contact_name']
    }).run().getRange({ start: 0, end: 1000 }) || [];

    log.debug('Accounting contacts found', 'project ' + projectId + ' count=' + results.length);

    results.forEach((res) => {
        const addr = res.getValue('custrecord_bc_contact_email');
        if (!addr) return;

        email.send({
            author: CONFIG.EMAIL_AUTHOR_ID,
            recipients: addr,
            cc: ['jainil.suthar@bluecollar.cloud'],
            subject,
            body
        });

        log.audit('Email -> Accounting Contact', 'project ' + projectId + ' to=' + addr + ' subject="' + subject + '"');
    });
    };

    const sendAccounting = (subject, body) => {
        email.send({
            author: CONFIG.EMAIL_AUTHOR_ID,
            recipients: CONFIG.ACCOUNTING_EMAIL,
            cc: ['jainil.suthar@bluecollar.cloud'],
            subject,
            body
        });
        log.audit('Email -> Accounting', 'to=' + CONFIG.ACCOUNTING_EMAIL + ' subject="' + subject + '"');
    };

    // ---------------------------------------------------------------
    // INVOICE CHECK
    // Cycle window = same CALENDAR MONTH as the Bill Date.  <-- assumption
    // Change the two date filters below to adjust the window.
    // ---------------------------------------------------------------
    const invoiceExistsInCycle = (projectId, billDate) => {
        const monthStart = new Date(billDate.getFullYear(), billDate.getMonth(), 1);
        const monthEnd = new Date(billDate.getFullYear(), billDate.getMonth() + 1, 0);

        const count = search.create({
            type: 'invoice',
            filters: [
                ['mainline', 'is', 'T'],
                'AND',
                [CONFIG.PROJECT_SEGMENT_FIELD, 'anyof', projectId],
                'AND',
                ['trandate', 'within',
                    format.format({ value: monthStart, type: format.Type.DATE }),
                    format.format({ value: monthEnd, type: format.Type.DATE })]
            ],
            columns: ['internalid']
        }).runPaged().count;

        return count > 0;
    };

    const summarize = (summary) => {
        summary.mapSummary.errors.iterator().each((key, err) => {
            log.error('Map error key ' + key, err);
            return true;
        });
    };

    return { getInputData, map, summarize };
});
