/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 *
 * KBS WIP -> COGS automation
 * --------------------------------------------------------------------------
 * Trigger : User Event on the INVOICE record.
 *   - On approval  -> pull every posted WIP cost line for the invoice's job
 *                     and create ONE journal entry that debits the COGS
 *                     account (from the item's COGS-mapping field) and
 *                     credits WIP (1806), line-for-line, with the source
 *                     bill + line id stamped on every JE line.
 *   - On delete    -> create a REVERSING journal entry for the relief JE(s)
 *                     previously created from this invoice.
 *
 * Scope    : Vendor bills only. (Labor / payroll JEs are handled by a
 *            separate script + search.)
 * --------------------------------------------------------------------------
 */
define(['N/record', 'N/search', 'N/log', 'N/format'], (record, search, log, format) => {

  // ===========================================================================
  // CONFIG  — everything that may differ by account lives here.
  //           Items flagged [CONFIRM] should be verified before go-live.
  // ===========================================================================
  const CONFIG = {
    // --- accounts / subsidiaries -------------------------------------------
    WIP_ACCOUNT: '1806',                       // credit (relief) account, internal id
    SUBSIDIARIES: ['39', '57', '11', '59', '6'], // KBS set; trigger gates on these

    // --- invoice fields -----------------------------------------------------
    INVOICE_JOB_FIELD: 'job',                  // invoice -> job link

    // --- approval detection -------------------------------------------------
    // Relief fires when the invoice transitions INTO the approved state.
    APPROVAL_FIELD: 'approvalstatus',          // [CONFIRM] field that holds approval state
    APPROVED_VALUE: '2',                       // [CONFIRM] "Approved" value in your account

    // --- item -> COGS mapping ----------------------------------------------
    // Returns the COGS account INTERNAL ID directly (per your confirmation).
    ITEM_COGS_FIELD: 'custitem_bc_cogsmapping',

    // --- JE line reference fields (provided) -------------------------------
    LINE_REF_TRANSACTION: 'custcol_bc_related_transaction',   // source bill record
    LINE_REF_LINE_ID:    'custcol_bc_related_tran_line_id',   // source line id

    // --- JE body fields -----------------------------------------------------
    // Body link back to the source invoice. Set on BOTH the relief JE and the
    // reversal JE, and used to locate the JE(s) on invoice delete.
    // (Distinct from the line-level custcol_bc_related_transaction.)
    JE_SOURCE_INVOICE_FIELD: 'custbody_bc_related_transaction',
    JE_AUTO_FLAG_FIELD:      'custbody_bc_auto_wip_relief',   // optional reporting flag
    JE_REVERSAL_FLAG_FIELD:  'custbody_bc_wip_reversal',      // optional: marks reversing JEs

    // --- segment / dimension fields carried from source line to JE line ----
    SEG_CUSTOMER_TYPE: 'cseg_kelso_custseg1',
    SEG_SERVICE_TYPE:  'cseg1'
  };

  // ===========================================================================
  // ENTRY POINT
  // ===========================================================================
  const afterSubmit = (context) => {
    try {
      const T = context.UserEventType;

      if (context.type === T.DELETE) {
        reverseReliefForInvoice(context.oldRecord);
        return;
      }

      if (context.type === T.CREATE || context.type === T.EDIT) {
      //  if (!isBecomingApproved(context)) return;
        createReliefForInvoice(context.newRecord);
      }
    } catch (e) {
      // Never block the invoice. Log loudly so it surfaces in the exec log / alerting.
      log.error({
        title: 'WIP->COGS afterSubmit failed',
        details: (e && e.stack) ? e.stack : JSON.stringify(e)
      });
    }
  };

  // ===========================================================================
  // APPROVAL DETECTION
  // ===========================================================================
  const isBecomingApproved = (context) => {
    const newStatus = context.newRecord.getValue({ fieldId: CONFIG.APPROVAL_FIELD });
    if (String(newStatus) !== String(CONFIG.APPROVED_VALUE)) return false;

    // On create, an already-approved invoice qualifies.
    if (context.type === context.UserEventType.CREATE) return true;

    // On edit, only the transition into approved qualifies (avoids re-firing on every save).
    const oldStatus = context.oldRecord
      ? context.oldRecord.getValue({ fieldId: CONFIG.APPROVAL_FIELD })
      : null;
    return String(oldStatus) !== String(CONFIG.APPROVED_VALUE);
  };

  // ===========================================================================
  // CREATE RELIEF JE
  // ===========================================================================
  const createReliefForInvoice = (invoice) => {
    const invoiceId  = invoice.id;
    const jobId      = invoice.getValue({ fieldId: CONFIG.INVOICE_JOB_FIELD });
    const subsidiary = invoice.getValue({ fieldId: 'subsidiary' });
    const tranId     = invoice.getValue({ fieldId: 'tranid' });
    const tranDate   = invoice.getValue({ fieldId: 'trandate' }); // same-period posting
    const invDateStr = tranDate ? format.format({ value: tranDate, type: format.Type.DATE }) : '';

    // --- gates --------------------------------------------------------------
    if (!jobId) {
      log.audit({ title: 'WIP relief skipped', details: `Invoice ${invoiceId} has no job.` });
      return;
    }
    if (CONFIG.SUBSIDIARIES.indexOf(String(subsidiary)) === -1) {
      log.audit({ title: 'WIP relief skipped', details: `Invoice ${invoiceId} subsidiary ${subsidiary} out of scope.` });
      return;
    }

    // --- idempotency: bail if a relief JE already exists for this invoice ---
    if (findReliefJEs(invoiceId).length > 0) {
      log.audit({ title: 'WIP relief skipped', details: `Relief JE already exists for invoice ${invoiceId}.` });
      return;
    }

    // --- pull WIP cost lines for the job -----------------------------------
    const costLines = runWipSearch(jobId);
    if (costLines.length === 0) {
      log.audit({ title: 'Zero WIP balance', details: `No WIP cost lines for job ${jobId} (invoice ${invoiceId}). No JE created.` });
      return;
    }

    // --- build the JE -------------------------------------------------------
    const je = record.create({ type: record.Type.JOURNAL_ENTRY, isDynamic: true });
    je.setValue({ fieldId: 'subsidiary', value: subsidiary });
    if (tranDate) je.setValue({ fieldId: 'trandate', value: tranDate });
    je.setValue({ fieldId: 'memo', value: `WIP relief — Inv ${tranId} / Job ${jobId} / ${invDateStr}` });
    setIfFieldExists(je, CONFIG.JE_SOURCE_INVOICE_FIELD, invoiceId);
    setIfFieldExists(je, CONFIG.JE_AUTO_FLAG_FIELD, true);

    const memo = `Inv ${tranId} | Job ${jobId} | ${invDateStr}`;
    const skipped = [];
    let linesAdded = 0;

    costLines.forEach((c) => {
      if (!c.cogsAccount) {
        // Item has no COGS mapping — cannot route. Skip + record for alerting.
        skipped.push({ bill: c.billId, line: c.lineId, reason: 'no COGS mapping on item' });
        return;
      }
      const amt = round2(c.debit - c.credit);
      if (amt === 0) return;

      if (amt > 0) {
        // Normal: relieve cost out of WIP into COGS.
        addJeLine(je, c.cogsAccount, amt, 0, c, memo, jobId);          // Dr COGS
        addJeLine(je, CONFIG.WIP_ACCOUNT, 0, amt, c, memo, jobId);     // Cr WIP
      } else {
        // Net credit on the source line — mirror the direction.
        const a = Math.abs(amt);
        addJeLine(je, c.cogsAccount, 0, a, c, memo, jobId);            // Cr COGS
        addJeLine(je, CONFIG.WIP_ACCOUNT, a, 0, c, memo, jobId);       // Dr WIP
      }
      linesAdded++;
    });

    if (linesAdded === 0) {
      log.audit({ title: 'Nothing to relieve', details: `All lines netted to zero or unmapped for invoice ${invoiceId}.` });
      if (skipped.length) log.error({ title: 'Unmapped cost lines', details: JSON.stringify(skipped) });
      return;
    }

    const jeId = je.save({ enableSourcing: true, ignoreMandatoryFields: false });
    log.audit({
      title: 'WIP relief JE created',
      details: `JE ${jeId} for invoice ${invoiceId} (job ${jobId}); ${linesAdded} cost line(s).`
    });

    if (jeId) {
      record.submitFields({type: 'invoice', id: invoiceId, values: {custbody_bc_related_transaction: jeId}})
    }

    if (skipped.length) {
      log.error({
        title: 'WIP relief: some lines skipped (no COGS mapping)',
        details: `Invoice ${invoiceId}: ` + JSON.stringify(skipped)
      });
    }
  };

  // Adds one JE line carrying dimensions + source references.
  const addJeLine = (je, account, debit, credit, c, memo, pid) => {
    je.selectNewLine({ sublistId: 'line' });
    je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: account });
    if (debit)  je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'debit',  value: debit });
    if (credit) je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'credit', value: credit });
    je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'memo', value: memo });
    je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'entity', value: pid });

    setLineIfPresent(je, 'department', c.department);
    setLineIfPresent(je, 'class',      c.classId);
    setLineIfPresent(je, 'location',   c.location);
    setLineIfPresent(je, CONFIG.SEG_CUSTOMER_TYPE, c.custType);
    setLineIfPresent(je, CONFIG.SEG_SERVICE_TYPE,  c.svcType);

    // Source traceability (your fields).
    setLineIfPresent(je, CONFIG.LINE_REF_TRANSACTION, c.billId);
    setLineIfPresent(je, CONFIG.LINE_REF_LINE_ID,     c.lineId);

    je.commitLine({ sublistId: 'line' });
  };

  // ===========================================================================
  // REVERSAL ON DELETE
  // ===========================================================================
  const reverseReliefForInvoice = (invoice) => {
    const invoiceId = invoice.id;
    const jeIds = findReliefJEs(invoiceId);
    if (jeIds.length === 0) {
      log.audit({ title: 'No relief JE to reverse', details: `Invoice ${invoiceId} deleted; no relief JE found.` });
      return;
    }

    jeIds.forEach((origId) => {
      const orig = record.load({ type: record.Type.JOURNAL_ENTRY, id: origId });
      const rev  = record.create({ type: record.Type.JOURNAL_ENTRY, isDynamic: true });

      rev.setValue({ fieldId: 'subsidiary', value: orig.getValue({ fieldId: 'subsidiary' }) });
      // Reversal posts on today's date so it lands in an open period
      // even if the original period is closed.
      rev.setValue({ fieldId: 'trandate', value: new Date() });
      rev.setValue({ fieldId: 'memo', value: `Reversal of JE ${origId} — source invoice ${invoiceId} deleted` });
      setIfFieldExists(rev, CONFIG.JE_SOURCE_INVOICE_FIELD, invoiceId);
      setIfFieldExists(rev, CONFIG.JE_REVERSAL_FLAG_FIELD, true);

      const count = orig.getLineCount({ sublistId: 'line' });
      for (let i = 0; i < count; i++) {
        const account = orig.getSublistValue({ sublistId: 'line', fieldId: 'account', line: i });
        const debit   = parseFloat(orig.getSublistValue({ sublistId: 'line', fieldId: 'debit',  line: i }) || 0);
        const credit  = parseFloat(orig.getSublistValue({ sublistId: 'line', fieldId: 'credit', line: i }) || 0);

        rev.selectNewLine({ sublistId: 'line' });
        rev.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: account });
        // swap debit <-> credit
        if (credit) rev.setCurrentSublistValue({ sublistId: 'line', fieldId: 'debit',  value: round2(credit) });
        if (debit)  rev.setCurrentSublistValue({ sublistId: 'line', fieldId: 'credit', value: round2(debit) });

        copyLineField(orig, rev, i, 'department');
        copyLineField(orig, rev, i, 'class');
        copyLineField(orig, rev, i, 'location');
        copyLineField(orig, rev, i, CONFIG.SEG_CUSTOMER_TYPE);
        copyLineField(orig, rev, i, CONFIG.SEG_SERVICE_TYPE);
        copyLineField(orig, rev, i, CONFIG.LINE_REF_TRANSACTION);
        copyLineField(orig, rev, i, CONFIG.LINE_REF_LINE_ID);
        rev.setCurrentSublistValue({ sublistId: 'line', fieldId: 'memo', value: `Reversal of JE ${origId}` });

        rev.commitLine({ sublistId: 'line' });
      }

      const revId = rev.save({ enableSourcing: true, ignoreMandatoryFields: false });
      log.audit({ title: 'WIP relief reversed', details: `Reversing JE ${revId} created for original JE ${origId} (invoice ${invoiceId}).` });
    });
  };

  // ===========================================================================
  // SEARCHES
  // ===========================================================================
  // Posted vendor-bill WIP cost lines for a given job.
  const runWipSearch = (jobId) => {
    const s = search.create({
      type: 'vendorbill',
      settings: [{ name: 'consolidationtype', value: 'ACCTTYPE' }],
      filters: [
        ['type', 'anyof', 'VendBill'], 'AND',
        ['account', 'anyof', CONFIG.WIP_ACCOUNT], 'AND',
        ['subsidiary', 'anyof', CONFIG.SUBSIDIARIES], 'AND',
        ['job.internalid', 'anyof', jobId], 'AND',
        ['posting', 'is', 'T']
      ],
      columns: [
        search.createColumn({ name: 'account' }),
        search.createColumn({ name: 'debitamount' }),
        search.createColumn({ name: 'creditamount' }),
        search.createColumn({ name: 'subsidiary' }),
        search.createColumn({ name: CONFIG.ITEM_COGS_FIELD, join: 'item' }),
        search.createColumn({ name: 'department' }),
        search.createColumn({ name: 'class' }),
        search.createColumn({ name: 'location' }),
        search.createColumn({ name: CONFIG.SEG_CUSTOMER_TYPE }),
        search.createColumn({ name: CONFIG.SEG_SERVICE_TYPE }),
        // line-level id for source-line traceability.
        // If custcol_bc_related_tran_line_id expects the line *sequence*
        // instead, swap 'lineuniquekey' for 'line'.
        search.createColumn({ name: 'lineuniquekey' })
      ]
    });

    const out = [];
    const pageData = s.runPaged({ pageSize: 1000 });
    pageData.pageRanges.forEach((pr) => {
      pageData.fetch({ index: pr.index }).data.forEach((r) => {
        out.push({
          billId:     r.id, // vendor bill internal id
          lineId:     r.getValue({ name: 'lineuniquekey' }),
          cogsAccount: r.getValue({ name: CONFIG.ITEM_COGS_FIELD, join: 'item' }),
          debit:      parseFloat(r.getValue({ name: 'debitamount' })  || 0),
          credit:     parseFloat(r.getValue({ name: 'creditamount' }) || 0),
          department: r.getValue({ name: 'department' }),
          classId:    r.getValue({ name: 'class' }),
          location:   r.getValue({ name: 'location' }),
          custType:   r.getValue({ name: CONFIG.SEG_CUSTOMER_TYPE }),
          svcType:    r.getValue({ name: CONFIG.SEG_SERVICE_TYPE })
        });
      });
    });
    return out;
  };

  // Finds relief JEs previously created from a given invoice.
  const findReliefJEs = (invoiceId) => {
    const ids = [];
    try {
      search.create({
        type: search.Type.JOURNAL_ENTRY,
        filters: [
          [CONFIG.JE_SOURCE_INVOICE_FIELD, 'anyof', invoiceId], 'AND',
          // exclude reversing JEs so a delete doesn't try to reverse a reversal
          [CONFIG.JE_REVERSAL_FLAG_FIELD, 'is', 'F']
        ],
        columns: [search.createColumn({ name: 'internalid' })]
      }).run().each((r) => { ids.push(r.id); return true; });
    } catch (e) {
      // If the reversal flag field doesn't exist yet, fall back to source-invoice only.
      search.create({
        type: search.Type.JOURNAL_ENTRY,
        filters: [[CONFIG.JE_SOURCE_INVOICE_FIELD, 'anyof', invoiceId]],
        columns: [search.createColumn({ name: 'internalid' })]
      }).run().each((r) => { ids.push(r.id); return true; });
    }
    return ids;
  };

  // ===========================================================================
  // HELPERS
  // ===========================================================================
  const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

  const setLineIfPresent = (rec, fieldId, value) => {
    if (value === null || value === undefined || value === '') return;
    try { rec.setCurrentSublistValue({ sublistId: 'line', fieldId, value }); }
    catch (e) { /* field not on JE line in this account — ignore */ }
  };

  const copyLineField = (src, dst, lineIdx, fieldId) => {
    try {
      const v = src.getSublistValue({ sublistId: 'line', fieldId, line: lineIdx });
      if (v !== null && v !== undefined && v !== '') {
        dst.setCurrentSublistValue({ sublistId: 'line', fieldId, value: v });
      }
    } catch (e) { /* ignore */ }
  };

  const setIfFieldExists = (rec, fieldId, value) => {
    try { rec.setValue({ fieldId, value }); }
    catch (e) { /* body field not created yet — ignore */ }
  };

  return { afterSubmit };
});
