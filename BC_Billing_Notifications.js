/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * BlueCollar - Daily Billing Notifications
 * -----------------------------------------
 * Runs daily. For each active project with a Bill Date:
 *   - 3 working days before Bill Date -> email Main PM + Phase PMs
 *   - 1 working day  before Bill Date -> email Accounting (invoice due)
 *   - On/after Bill Date with no invoice in cycle -> daily reminder to
 *     Main PM + Accounting, UNLESS the "No Billing This Cycle" checkbox
 *     is set (then send Accounting the reason once).
 *
 * Business-day math currently excludes WEEKENDS only. Holidays are
 * pluggable: drop dates into HOLIDAYS (or swap getHolidays() to read a
 * custom record) and the rest of the logic picks them up automatically.
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

        // Project (customrecord_cseg_bc_project) header fields
        FIELD_MAIN_PM: 'custrecord_bc_proj_manager',
        FIELD_BILL_DATE: 'custrecord_bill_date', // LIST field: text = day of month ('1'..'30') or 'EOM'
        FIELD_NO_BILL: 'custrecord_bc_no_bill',
        FIELD_NO_BILL_REASON: 'custrecord_bc_no_bill_reason',
        FIELD_NO_BILL_DATE: 'custrecord_bc_no_bill_date',

        PHASE_PM_POSITION: '3'      // custrecord_bc_position value for Phase PM
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
        return search.create({
            type: 'customrecord_cseg_bc_project',
            filters: [
                ['isinactive', 'is', 'F'],
                'AND',
                [CONFIG.FIELD_BILL_DATE, 'noneof', '@NONE@']
            ],
            columns: [
                'internalid',
                CONFIG.FIELD_BILL_DATE,
                CONFIG.FIELD_MAIN_PM,
                CONFIG.FIELD_NO_BILL,
                CONFIG.FIELD_NO_BILL_REASON,
                CONFIG.FIELD_NO_BILL_DATE
            ]
        });
    };

    // ---------------------------------------------------------------
    // 2) MAP: decide and send for one project
    // ---------------------------------------------------------------
    const map = (context) => {
        try {
          log.debug('v', v)
            const r = JSON.parse(context.value);
            const v = r.values;
            log.debug('v', v)

            const projectId = r.id;

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
                mainPmId: mainPmId
            });

            // --- 3 working days before upcoming bill date: notify PMs ---
            if (sameDay(now, pmTriggerDate)) {
                log.audit('PM trigger HIT', 'project ' + projectId + ' (' + ymd(now) + ')');
                notifyMainPm(mainPmId, projectId, upcomingDisplay);
                notifyPhasePms(projectId);
            }

            // --- 1 working day before upcoming bill date: notify Accounting ---
            if (sameDay(now, acctTriggerDate)) {
                log.audit('Accounting trigger HIT', 'project ' + projectId + ' (' + ymd(now) + ')');
                sendAccounting(
                    `Invoice creation due tomorrow - project ${projectId}`,
                    `An invoice is due to be created for project ${projectId} on ${upcomingDisplay}.`
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
                    const reason = v[CONFIG.FIELD_NO_BILL_REASON] || '(no reason provided)';
                    log.audit('No-bill flagged', 'project ' + projectId + ' reason: ' + reason);
                    sendAccounting(
                        `No billing this cycle - project ${projectId}`,
                        `PM marked project ${projectId} as no-billing for ${recentDisplay}.\nReason: ${reason}`
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
                    notifyMainPm(mainPmId, projectId, recentDisplay, true);
                    sendAccounting(
                        `REMINDER: no invoice yet - project ${projectId}`,
                        `No invoice has been created for project ${projectId} (Bill Date ${recentDisplay}).`
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
    const notifyMainPm = (pmId, projectId, billDisplay, isReminder) => {
        if (!pmId) {
            log.audit('No Main PM set', 'project ' + projectId);
            return;
        }
        const subject = isReminder
            ? `REMINDER: billing due - project ${projectId}`
            : `Your billing is due on ${billDisplay}`;
        const body = isReminder
            ? `Reminder: no invoice has been submitted for project ${projectId} (due ${billDisplay}).`
            : `Your billing is due on ${billDisplay} for project ${projectId}.`;
        email.send({
            author: CONFIG.EMAIL_AUTHOR_ID,
            recipients: pmId,        // employee internal id; NetSuite resolves the address
            subject,
            body
        });
        log.audit('Email -> Main PM', 'project ' + projectId + ' pmId=' + pmId + ' subject="' + subject + '"');
    };

    const notifyPhasePms = (projectId) => {
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
                subject: 'Action needed: submit schedule of values',
                body: `Please submit your schedule of values to the main PM for project ${projectId}.`
            });
            log.audit('Email -> Phase PM', 'project ' + projectId + ' to=' + addr);
        });
    };

    const sendAccounting = (subject, body) => {
        email.send({
            author: CONFIG.EMAIL_AUTHOR_ID,
            recipients: CONFIG.ACCOUNTING_EMAIL,
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