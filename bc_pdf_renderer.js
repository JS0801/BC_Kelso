/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 *
 * PDF rendering — wraps N/render with the BFO/FreeMarker templates
 * shipped under templates/pdf/. Subsidiary co-branding is resolved
 * inline (subsidiary record → display name + main address + logo URL);
 * the more elaborate bc_branding_resolver scoping chain ships later.
 *
 * Templates:
 *   - _shared.bfo.xml              CSS partial (mirrors design tokens)
 *   - transmittal-cover.bfo.xml    REAL — Phase 3.2 Section D
 *   - closeout-external.bfo        deferred
 *   - closeout-internal.bfo        deferred
 *   - submittal-export.bfo         deferred
 */
define([
  'N/render', 'N/file', 'N/query', 'N/record', 'N/search', 'N/runtime', 'N/log',
  '../../Shared/lib/bc_submittal_constants',
  '../../Shared/lib/bc_submittal_errors',
  './bc_line_dao',
  './bc_response_dao',
  './bc_file_dao',
  './bc_workflow_logic',
  './bc_branding_resolver',
  './bc_project_dao',
  './bc_event_log'
], (render, file, query, record, search, runtime, log, C, errors, lineDao, responseDao, fileDao, workflowLogic, brandingResolver, projectDao, eventLog) => {

  // sourceName → human label for the change-history "PDF generated" row.
  const _GENERATED_PDF_LABELS = {
    generated_transmittal_cover: 'Cover PDF generated',
    generated_submittal_pdf:     'Submittal PDF generated',
    generated_closeout_external: 'Closeout PDF generated',
    generated_closeout_internal: 'Closeout PDF generated'
  };

  const TEMPLATE_PATHS = {
    TRANSMITTAL_COVER: '/SuiteScripts/BlueCollarSubmittals/templates/pdf/transmittal-cover.bfo.xml',
    CLOSEOUT:          '/SuiteScripts/BlueCollarSubmittals/templates/pdf/closeout.bfo.xml',
    SUBMITTAL_EXPORT:  '/SuiteScripts/BlueCollarSubmittals/templates/pdf/submittal-export.bfo.xml'
  };

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  const _fmtCurrency = (n) => {
    if (n == null) return '';
    return Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  };

  const _fmtDate = (d) => {
    if (!d) return '';
    const dt = (d instanceof Date) ? d : new Date(d);
    if (isNaN(dt.getTime())) return String(d);
    return `${dt.getMonth() + 1}/${dt.getDate()}/${dt.getFullYear()}`;
  };

  const _fmtTimestamp = (d) => {
    if (!d) return '';
    const dt = (d instanceof Date) ? d : new Date(d);
    if (isNaN(dt.getTime())) return String(d);
    return `${_fmtDate(dt)} ${dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
  };

  // (Inline _loadSubsidiaryBranding superseded by bc_branding_resolver.resolve
  //  in Section J — the resolver walks the full submittal → subsidiary →
  //  parent-chain → tenant-default hierarchy per spec §7.6.)

  /**
   * Single SuiteQL to gather every header field the cover template needs.
   * One round-trip is materially faster than loading the records, given
   * NS's record.load cost (~10-20 governance units each + a network hop).
   */
  const _loadCoverContext = (transmittalId) => {
    const rows = query.runSuiteQL({
      query: `
        SELECT
          xmit.id                                              AS xmit_id,
          xmit.custrecord_bc_xmits_revision                     AS revision_id,
          rev.custrecord_bc_revs_number                         AS rev_number,
          rev.custrecord_bc_revs_submittal                      AS submittal_id,
          xmit.custrecord_bc_xmits_subject                      AS subject,
          xmit.custrecord_bc_xmits_sent_by                      AS sent_by_id,
          BUILTIN.DF(xmit.custrecord_bc_xmits_sent_by)          AS sent_by_name,
          TO_CHAR(xmit.custrecord_bc_xmits_sent_date, 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM')
                                                               AS sent_at,
          sub.name                                             AS sub_number,
          sub.custrecord_bc_subs_title                          AS title,
          BUILTIN.DF(sub.custrecord_bc_subs_spec_section)       AS spec_section,
          BUILTIN.DF(sub.custrecord_bc_subs_type)               AS type_name,
          BUILTIN.DF(sub.custrecord_bc_subs_status)             AS status_name,
          sub.custrecord_bc_subs_due_date                       AS due_date,
          BUILTIN.DF(sub.custrecord_bc_subs_ball_in_court)      AS bic_name,
          sub.custrecord_bc_subs_vendor                         AS vendor_id,
          COALESCE(vendor.companyname, vendor.entityid)          AS vendor_name,
          sub.custrecord_bc_subs_project                        AS project_id,
          BUILTIN.DF(sub.custrecord_bc_subs_project)            AS project_name,
          proj.custrecord_bc_proj_number                      AS project_number,
          proj.custrecord_bc_proj_subsidiary                  AS project_subsidiary_id
        FROM customrecord_bc_submittals_transmittal xmit
        INNER JOIN customrecord_bc_submittals_revision rev
          ON rev.id = xmit.custrecord_bc_xmits_revision
        INNER JOIN customrecord_bc_submittals sub
          ON sub.id = rev.custrecord_bc_revs_submittal
        LEFT JOIN customrecord_cseg_bc_project proj
          ON proj.id = sub.custrecord_bc_subs_project
        LEFT JOIN vendor vendor
          ON vendor.id = sub.custrecord_bc_subs_vendor
        WHERE xmit.id = ?
      `,
      params: [Number(transmittalId)]
    }).asMappedResults();
    if (!rows.length) throw errors.notFound('transmittal', transmittalId);
    return rows[0];
  };

  // -------------------------------------------------------------------
  // Luke-revisions §7.4 — load cover context from a submittal + revision
  // (no transmittal exists yet — used by revision-create auto-cover and
  // the on-demand "Generate Cover PDF" UI affordances).
  // -------------------------------------------------------------------

  const _loadCoverContextBySubRev = (submittalId, revisionId) => {
    const rows = query.runSuiteQL({
      query: `
        SELECT
          rev.id                                               AS revision_id,
          rev.custrecord_bc_revs_number                         AS rev_number,
          sub.id                                               AS submittal_id,
          sub.name                                             AS sub_number,
          sub.custrecord_bc_subs_title                          AS title,
          BUILTIN.DF(sub.custrecord_bc_subs_spec_section)       AS spec_section,
          BUILTIN.DF(sub.custrecord_bc_subs_type)               AS type_name,
          BUILTIN.DF(sub.custrecord_bc_subs_status)             AS status_name,
          sub.custrecord_bc_subs_due_date                       AS due_date,
          BUILTIN.DF(sub.custrecord_bc_subs_ball_in_court)      AS bic_name,
          sub.custrecord_bc_subs_vendor                         AS vendor_id,
          COALESCE(vendor.companyname, vendor.entityid)          AS vendor_name,
          sub.custrecord_bc_subs_lead_time                      AS lead_time,
          sub.custrecord_bc_subs_project                        AS project_id,
          BUILTIN.DF(sub.custrecord_bc_subs_project)            AS project_name,
          proj.custrecord_bc_proj_number                      AS project_number,
          proj.custrecord_bc_proj_subsidiary                  AS project_subsidiary_id
        FROM customrecord_bc_submittals_revision rev
        INNER JOIN customrecord_bc_submittals sub
          ON sub.id = rev.custrecord_bc_revs_submittal
        LEFT JOIN customrecord_cseg_bc_project proj
          ON proj.id = sub.custrecord_bc_subs_project
        LEFT JOIN vendor vendor
          ON vendor.id = sub.custrecord_bc_subs_vendor
        WHERE rev.id = ?
          AND sub.id = ?
      `,
      params: [Number(revisionId), Number(submittalId)]
    }).asMappedResults();
    if (!rows.length) throw errors.notFound('revision', revisionId);
    return rows[0];
  };

  // -------------------------------------------------------------------
  // renderTransmittalCover — REAL (Phase 3.2 Section D)
  //
  // Renders the cover PDF, saves to /BlueCollar Submittals/Generated/,
  // returns { fileId, fileName, fileSize }. Callers (a future "Download
  // PDF" SPA button, bc_revision_dao.create auto-cover, SubmittalDetail
  // ⋯ More menu) decide what to do with the file id.
  //
  // Luke-revisions §7.4 — function decoupled from `send`. Accepts either:
  //   - a transmittalId (legacy, when invoked from a transmittal record), or
  //   - { submittalId, revisionId } (new — auto-cover-on-revision-create,
  //     on-demand "Generate Cover PDF" from SubmittalDetail)
  //
  // When invoked via submittal+revision, transmittal-specific fields
  // (sentDate, subject, complianceLine) are blank — those only make
  // sense for an actual sent transmittal.
  // -------------------------------------------------------------------

  // Cover-only branding enrichment. Use the subsidiary record/address
  // subrecord instead of unavailable SuiteQL address columns.
  const _formatCoverPhone = (value) => {
    const raw = String(value || '').trim();
    let digits = raw.replace(/\D/g, '');
    if (digits.length === 11 && digits.charAt(0) === '1') {
      digits = digits.slice(1);
    }
    return digits.length === 10
      ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
      : raw;
  };

  const _loadCoverBranding = (submittalId, subsidiaryId) => {
    const branding = Object.assign({}, brandingResolver.resolve(submittalId));
    const id = Number(subsidiaryId) || Number(branding.subsidiaryId);
    if (!id) return branding;
    try {
      const subsidiary = record.load({ type: record.Type.SUBSIDIARY || 'subsidiary', id, isDynamic: false });
      const read = (rec, fieldId) => {
        try { return String(rec.getValue({ fieldId }) || '').trim(); }
        catch (e) { return ''; }
      };
      branding.name = read(subsidiary, 'legalname') || read(subsidiary, 'name') || branding.name;
      branding.phone = read(subsidiary, 'phone');
      let addressText = '';
      try {
        const address = subsidiary.getSubrecord({ fieldId: 'mainaddress' });
        if (address) {
          // Keep company name in its own header line; omit the duplicate addressee.
          const street = ['addr1', 'addr2', 'addr3'].map((f) => read(address, f)).filter(Boolean);
          const city = read(address, 'city');
          const stateZip = [read(address, 'state'), read(address, 'zip')].filter(Boolean).join(' ');
          const locality = [city, stateZip].filter(Boolean).join(', ');
          if (locality) street.push(locality);
          addressText = street.join('\n') || read(address, 'addrtext');
          branding.phone = branding.phone || read(address, 'addrphone');
        }
      } catch (e) {
        log.error({ title: 'Cover PDF: subsidiary main address unavailable', details: `subsidiaryId=${id}: ${e.message}` });
      }
      addressText = addressText || read(subsidiary, 'mainaddress_text');
      if (addressText) branding.address = addressText.replace(/\r\n|\r|\n/g, '<br/>');
    } catch (e) {
      log.error({ title: 'Cover PDF: subsidiary branding unavailable', details: `subsidiaryId=${id}: ${e.message}` });
    }
    return branding;
  };

  // Supplier details for the cover: default billing address, then default
  // shipping, then the first address. Address-book labels are not printed.
  const _loadCoverSupplier = (vendorId) => {
    const supplier = { name: '', address: '', cityStateZip: '', phone: '', fax: '' };
    const id = Number(vendorId);
    if (!id) return supplier;
    const read = (rec, fieldId) => {
      try { return String(rec.getValue({ fieldId }) || '').trim(); }
      catch (e) { return ''; }
    };
    try {
      const vendor = record.load({ type: record.Type.VENDOR || 'vendor', id, isDynamic: false });
      supplier.name = read(vendor, 'companyname') ||
        [read(vendor, 'firstname'), read(vendor, 'lastname')].filter(Boolean).join(' ') ||
        read(vendor, 'entityid');
      supplier.phone = _formatCoverPhone(read(vendor, 'phone'));
      supplier.fax = _formatCoverPhone(read(vendor, 'fax'));
      const count = vendor.getLineCount({ sublistId: 'addressbook' });
      let billing = -1, shipping = -1;
      const checked = (value) => value === true || value === 'T';
      for (let line = 0; line < count; line++) {
        if (billing < 0 && checked(vendor.getSublistValue({ sublistId: 'addressbook', fieldId: 'defaultbilling', line }))) billing = line;
        if (shipping < 0 && checked(vendor.getSublistValue({ sublistId: 'addressbook', fieldId: 'defaultshipping', line }))) shipping = line;
      }
      const line = billing >= 0 ? billing : shipping >= 0 ? shipping : count > 0 ? 0 : -1;
      if (line >= 0) {
        const address = vendor.getSublistSubrecord({ sublistId: 'addressbook', fieldId: 'addressbookaddress', line });
        supplier.address = ['addr1', 'addr2', 'addr3'].map((fieldId) => read(address, fieldId)).filter(Boolean).join('\n');
        const stateZip = [read(address, 'state'), read(address, 'zip')].filter(Boolean).join(' ');
        supplier.cityStateZip = [read(address, 'city'), stateZip].filter(Boolean).join(', ');
        supplier.phone = supplier.phone || _formatCoverPhone(read(address, 'addrphone'));
      }
    } catch (e) {
      log.error({ title: 'Cover PDF: vendor details unavailable', details: `vendorId=${id}: ${e.message}` });
    }
    return supplier;
  };

  const renderTransmittalCover = (params) => {
    // Argument shape detection — accept either a primitive (legacy
    // transmittalId) or an object with submittalId + revisionId.
    let ctx, xmitId = 0, subId = 0, revisionId = 0;

    // Suppress the generated-PDF history row when the caller already logs the
    // originating action (revision-create auto-generates a cover and logs its
    // own "Revision created"). Manual "Generate Cover PDF" clicks omit this.
    const skipHistory = !!(params && typeof params === 'object' && params.skipHistory);

    if (params && typeof params === 'object' && (params.submittalId || params.revisionId)) {
      subId      = Number(params.submittalId) || 0;
      revisionId = Number(params.revisionId)  || 0;
      if (!subId || !revisionId) {
        throw errors.badInput('renderTransmittalCover({submittalId, revisionId}): both required');
      }
      ctx = _loadCoverContextBySubRev(subId, revisionId);
    } else {
      xmitId = Number(params);
      if (!xmitId) throw errors.badInput('transmittalId or {submittalId, revisionId} is required');
      ctx = _loadCoverContext(xmitId);
      subId      = Number(ctx.submittal_id) || 0;
      revisionId = Number(ctx.revision_id)  || 0;
    }

    const supplier = _loadCoverSupplier(ctx.vendor_id);
    const linesResult = subId ? lineDao.list(subId) : { rows: [] };
    const branding    = _loadCoverBranding(subId, ctx.project_subsidiary_id);

    // Luke-revisions §7.6 — pull architect/engineer/GC stub addresses.
    // Currently returns three nulls; cover template renders blank labeled
    // blocks until the field-binding details land.
    const addresses = projectDao.getAddresses(Number(ctx.project_id) || 0);

    const revLabel = `R${ctx.rev_number != null ? Number(ctx.rev_number) : 0}`;

    const data = {
      subsidiaryName:    branding.name,
      subsidiaryAddress: branding.address,
      subsidiaryPhone:   _formatCoverPhone(branding.phone),
      subsidiaryLogo:    branding.logoUrl,
      projectName:       ctx.project_name || '',
      projectNumber:     ctx.project_number == null ? '' : String(ctx.project_number),
      submittalNumber:   ctx.sub_number || '',
      title:             ctx.title || '',
      revisionLabel:     revLabel,
      specSection:       ctx.spec_section || '',
      type:              ctx.type_name || '',
      status:            ctx.status_name || '',
      dueDate:           _fmtDate(ctx.due_date),
      ballInCourt:       ctx.bic_name || '',
      vendor:            ctx.vendor_name || '',
      vendor:            supplier.name || ctx.vendor_name || '',
      supplierAddress:   supplier.address,
      supplierCityStateZip: supplier.cityStateZip,
      supplierPhone:     supplier.phone,
      supplierFax:       supplier.fax,
      // Luke-revisions §3.1 / §7.6 — lead time + submittal date on cover.
      leadTime:          ctx.lead_time || '',
      submittalDate:     _fmtDate(new Date()),
      sentDate:          _fmtTimestamp(ctx.sent_at),
      subject:           ctx.subject || '',
      // Luke-revisions §7.6 — Architect / Engineer / GC stubs (null until
      // bc_project_dao.getAddresses is wired to the project address sub-record).
      architect:           addresses.architect,
      engineer:            addresses.engineer,
      generalContractor:   addresses.generalContractor,
      lines:             linesResult.rows.map((l) => ({
        position:     l.position || '',
        description:  l.description || '',
        model:        l.model || '',
        manufacturer: l.manufacturer || '',
        qty:          l.qty != null ? String(l.qty) : '',
        uom:          l.uom || '',
        unitCost:     _fmtCurrency(l.unitCost),
        outcome:      l.outcome || ''
      })),
      complianceLine: ctx.sent_by_name
        ? `Submitted by ${ctx.sent_by_name} on ${_fmtDate(ctx.sent_at)}`
        : null
    };

    const renderer = render.create();
    renderer.templateContent = file.load({ id: TEMPLATE_PATHS.TRANSMITTAL_COVER }).getContents();
    renderer.addCustomDataSource({
      format: render.DataSource.OBJECT,
      alias:  'record',
      data:   data
    });

    const pdfFile = renderer.renderAsPdf();
    // File naming: when there's no transmittal, use submittal+revision only.
    pdfFile.name   = xmitId
      ? `Transmittal-${ctx.sub_number || subId}-${revLabel}-${xmitId}.pdf`
      : `Cover-${ctx.sub_number || subId}-${revLabel}.pdf`;
    pdfFile.folder = _resolveGeneratedFolderId();

    const fileId = pdfFile.save();
    _attachGeneratedFile(subId, revisionId, fileId, pdfFile.name, 'generated_transmittal_cover', skipHistory);

    return {
      fileId:   Number(fileId),
      fileName: pdfFile.name,
      submittalNumber: ctx.sub_number || '',
      revisionLabel:   revLabel
    };
  };

  // -------------------------------------------------------------------
  // _attachGeneratedFile — wire a saved PDF into the Files section by
  // creating the customrecord_bc_submittals_file junction row. Without
  // this the PDF lands in /BlueCollar Submittals/Generated/ but is
  // invisible to bc_file_dao.listForSubmittal (which only joins through
  // the junction). Section U fix.
  //
  // source ∈ generated_transmittal_cover | generated_closeout_external |
  //          generated_closeout_internal | generated_submittal_pdf
  // Non-fatal — junction failure logs an error but doesn't roll back the
  // PDF itself (the file still exists in the cabinet; users can find it
  // there manually).
  // -------------------------------------------------------------------

  let _fileSourceIdCache = null;
  const _resolveFileSourceId = (sourceName) => {
    if (!_fileSourceIdCache) _fileSourceIdCache = {};
    if (sourceName in _fileSourceIdCache) return _fileSourceIdCache[sourceName];
    try {
      const results = search.create({
        type:    C.LISTS.FILE_SOURCE,
        filters: [['name', 'is', sourceName]],
        columns: []
      }).run().getRange({ start: 0, end: 1 });
      const id = results.length ? Number(results[0].id) : '';
      _fileSourceIdCache[sourceName] = id;
      return id;
    } catch (e) {
      _fileSourceIdCache[sourceName] = '';
      return '';
    }
  };

  const _attachGeneratedFile = (submittalId, revisionId, nsFileId, fileName, sourceName, skipHistory) => {
    try {
      const sourceId = _resolveFileSourceId(sourceName);
      if (!sourceId) return;     // file_source list value missing — skip junction

      // Bugfix sweep #8 — file.save() is idempotent by (name, folder), so a
      // re-export returns the SAME ns file id (contents refreshed). Upsert on
      // the (submittal, ns_file, source) tuple or every re-export piles up a
      // duplicate Files row pointing at one file. Exists-check failure falls
      // through to insert — never block the PDF over the dedup query.
      let existingId = null;
      try {
        const existing = query.runSuiteQL({
          query: `SELECT id FROM customrecord_bc_submittals_file
                   WHERE custrecord_bc_files_submittal = ?
                     AND custrecord_bc_files_ns_file = ?
                     AND custrecord_bc_files_source = ?
                   FETCH FIRST 1 ROWS ONLY`,
          params: [Number(submittalId), Number(nsFileId), sourceId]
        }).asMappedResults();
        if (existing.length) existingId = Number(existing[0].id);
      } catch (e) {
        // exists-check failed — fall through to insert
      }
      if (existingId) {
        // Update failure is swallowed by the outer catch — it must NOT
        // fall through to insert (the row exists; inserting would
        // recreate the duplicate this upsert removes).
        record.submitFields({
          type:    C.RECORDS.SUBMITTAL_FILE,
          id:      existingId,
          values:  { custrecord_bc_files_uploaded_date: new Date() },
          options: { enableSourcing: false, ignoreMandatoryFields: true }
        });
        return;
      }

      const now    = new Date();
      const userId = (() => {
        try {
          const u = runtime.getCurrentUser ? runtime.getCurrentUser() : null;
          return u && u.id ? Number(u.id) : 0;
        } catch (e) { return 0; }
      })();
      const rec = record.create({ type: C.RECORDS.SUBMITTAL_FILE, isDynamic: false });
      rec.setValue({ fieldId: 'name',                              value: `Sub ${submittalId} R${revisionId || 0} ${fileName}` });
      rec.setValue({ fieldId: 'custrecord_bc_files_submittal',      value: Number(submittalId) });
      if (revisionId) rec.setValue({ fieldId: 'custrecord_bc_files_revision', value: Number(revisionId) });
      rec.setValue({ fieldId: 'custrecord_bc_files_ns_file',        value: Number(nsFileId) });
      rec.setValue({ fieldId: 'custrecord_bc_files_source',         value: sourceId });
      if (userId) rec.setValue({ fieldId: 'custrecord_bc_files_uploaded_by', value: userId });
      rec.setValue({ fieldId: 'custrecord_bc_files_uploaded_date',  value: now });
      rec.save({ enableSourcing: false, ignoreMandatoryFields: false });

      // Change-history: a brand-new generated PDF landed in Files — log it so
      // it's visible in the audit trail (was previously invisible). Only on
      // the INSERT path: a re-export of the same (sub, rev) hits the upsert
      // branch above and returns early, so we don't spam a row per re-export.
      // skipHistory suppresses the auto-cover row on revision-create, which
      // already logs its own "Revision created" event.
      if (!skipHistory && Number(submittalId) > 0) {
        eventLog.logEvent(Number(submittalId), {
          category: 'attachment',
          label:    _GENERATED_PDF_LABELS[sourceName] || 'PDF generated',
          from:     '',
          to:       fileName || ''
        });
      }
    } catch (e) {
      // Junction creation failure is non-fatal — PDF still exists in cabinet.
      // Caller can choose to log; we don't have N/log here without bloating
      // the require list.
    }
  };

  /**
   * Resolve the /BlueCollar Submittals/Generated/ folder id. The install
   * Suitelet seeds folder 1763 by spec; we look it up by path each time
   * the renderer is invoked to stay sandbox-portable. The lookup is cheap
   * (NS folder index) and avoids hard-coding the id.
   */
  let _generatedFolderId = null;
  const _resolveGeneratedFolderId = () => {
    if (_generatedFolderId) return _generatedFolderId;
    const rows = query.runSuiteQL({
      query:  `SELECT folder.id FROM mediaitemfolder folder
                WHERE folder.name = 'Generated'
                  AND folder.parent IN (
                    SELECT id FROM mediaitemfolder WHERE name = 'BlueCollar Submittals' AND parent IS NULL
                  )`,
      params: []
    }).asMappedResults();
    if (!rows.length) {
      throw errors.notFound('folder', '/BlueCollar Submittals/Generated');
    }
    _generatedFolderId = Number(rows[0].id);
    return _generatedFolderId;
  };

  // -------------------------------------------------------------------
  // Loaders for the submittal header used by closeout + export.
  // -------------------------------------------------------------------

  const _loadSubmittalHeader = (submittalId) => {
    const rows = query.runSuiteQL({
      query: `
        SELECT
          sub.id                                                AS id,
          sub.name                                              AS sub_number,
          sub.custrecord_bc_subs_title                           AS title,
          BUILTIN.DF(sub.custrecord_bc_subs_spec_section)        AS spec_section,
          BUILTIN.DF(sub.custrecord_bc_subs_type)                AS type_name,
          BUILTIN.DF(sub.custrecord_bc_subs_status)              AS status_name,
          sub.custrecord_bc_subs_due_date                        AS due_date,
          sub.custrecord_bc_subs_closed_date                     AS closed_date,
          BUILTIN.DF(sub.custrecord_bc_subs_ball_in_court)       AS bic_name,
          BUILTIN.DF(sub.custrecord_bc_subs_vendor)              AS vendor_name,
          sub.custrecord_bc_subs_project                         AS project_id,
          BUILTIN.DF(sub.custrecord_bc_subs_project)             AS project_name,
          sub.custrecord_bc_subs_notes                           AS internal_notes,
          sub.custrecord_bc_subs_current_revision                AS current_rev_id
        FROM customrecord_bc_submittals sub
        WHERE sub.id = ?
      `,
      params: [Number(submittalId)]
    }).asMappedResults();
    if (!rows.length) throw errors.notFound('submittal', submittalId);
    return rows[0];
  };

  const _formatLines = (lineRows) => lineRows.map((l) => ({
    position:     l.position || '',
    description:  l.description || '',
    model:        l.model || '',
    manufacturer: l.manufacturer || '',
    qty:          l.qty != null ? String(l.qty) : '',
    uom:          l.uom || '',
    unitCost:     _fmtCurrency(l.unitCost),
    outcome:      l.outcome || ''
  }));

  const _formatComments = (commentRows) => commentRows.map((c) => ({
    revisionLabel: c.revisionLabel || '',
    source:        c.source || 'internal',
    commentType:   c.commentType || 'general_comment',
    authorName:    c.authorName || '',
    createdAt:     _fmtTimestamp(c.createdAt),
    bodyHtml:      c.bodyHtml || '',
    outcome:       c.outcome || ''
  }));

  // -------------------------------------------------------------------
  // renderCloseout — REAL (Phase 3.2 Section I)
  //
  // Pulls submittal header + lines + full workflow + comments + files,
  // renders the closeout template. Variant ∈ {'external','internal'}:
  // 'internal' includes PM notes block + internal-only comments (today
  // every comment ships in the bundle; refinement to "only formal_response
  // + external-visible" for external variant lands when we have the
  // external-visibility flag plumbing per spec §7.5).
  // -------------------------------------------------------------------

  const renderCloseout = (submittalId, variant) => {
    const subId = Number(submittalId);
    if (!subId) throw errors.badInput('submittalId is required');
    const v = (variant === 'internal') ? 'internal' : 'external';

    const header = _loadSubmittalHeader(subId);

    let workflowSteps = [];
    try {
      const wf = workflowLogic.getSubmittalWorkflow(subId);
      workflowSteps = (wf.steps || []).map((s) => ({
        name:          s.name || '',
        status:        s.status || 'pending',
        completedDate: _fmtDate(s.completedDate),
        completedBy:   s.completedByName || '',
        approvers: (s.approvers || []).map((a) => ({
          displayName:  a.displayName || '',
          type:         a.type || 'employee',
          required:     a.required === true,
          responded:    a.responded === true,
          outcome:      a.outcome || '',
          responseDate: _fmtDate(a.responseDate)
        }))
      }));
    } catch (e) { /* workflow absent or errored — render closeout anyway */ }

    const lineRows  = (lineDao.list(subId).rows) || [];
    const responses = (responseDao.listForSubmittal(subId).rows) || [];
    const files     = (fileDao.listForSubmittal(subId).rows) || [];
    const branding  = brandingResolver.resolve(subId);

    const data = {
      variant:           v,
      includeInternal:   (v === 'internal'),
      generatedAt:       _fmtTimestamp(new Date()),
      subsidiaryName:    branding.name,
      subsidiaryAddress: branding.address,
      subsidiaryLogo:    branding.logoUrl,
      projectName:       header.project_name || '',
      submittalNumber:   header.sub_number || '',
      title:             header.title || '',
      specSection:       header.spec_section || '',
      type:              header.type_name || '',
      status:            header.status_name || '',
      closedDate:        _fmtDate(header.closed_date),
      ballInCourt:       header.bic_name || '',
      vendor:            header.vendor_name || '',
      internalNotes:     v === 'internal' ? (header.internal_notes || '') : '',
      lines:             _formatLines(lineRows),
      workflowSteps:     workflowSteps,
      responses:         _formatComments(responses),
      files:             files.map((f) => ({
        name:           f.fileName,
        source:         f.source,
        revisionLabel:  f.revisionLabel,
        uploadedByName: f.uploadedByName
      }))
    };

    const renderer = render.create();
    renderer.templateContent = file.load({ id: TEMPLATE_PATHS.CLOSEOUT }).getContents();
    renderer.addCustomDataSource({
      format: render.DataSource.OBJECT,
      alias:  'record',
      data:   data
    });
    const pdfFile = renderer.renderAsPdf();
    pdfFile.name   = `Closeout-${header.sub_number || subId}-${v}.pdf`;
    pdfFile.folder = _resolveGeneratedFolderId();
    const fileId   = pdfFile.save();
    const closeoutSource = v === 'internal' ? 'generated_closeout_internal' : 'generated_closeout_external';
    _attachGeneratedFile(subId, Number(header.current_rev_id) || 0, fileId, pdfFile.name, closeoutSource);

    return {
      fileId:          Number(fileId),
      fileName:        pdfFile.name,
      variant:         v,
      submittalNumber: header.sub_number || ''
    };
  };

  // -------------------------------------------------------------------
  // renderSubmittalExport — REAL (Phase 3.2 Section I)
  //
  // On-demand "give me this submittal as a PDF right now." Same brand
  // bar + meta + items as the cover, plus 10 most recent comments.
  // No workflow timeline, no PM-notes; that's closeout territory.
  // -------------------------------------------------------------------

  const renderSubmittalExport = (submittalId) => {
    const subId = Number(submittalId);
    if (!subId) throw errors.badInput('submittalId is required');

    const header = _loadSubmittalHeader(subId);
    const revisionRows = query.runSuiteQL({
      query:  'SELECT custrecord_bc_revs_number AS n FROM customrecord_bc_submittals_revision WHERE id = ?',
      params: [Number(header.current_rev_id) || 0]
    }).asMappedResults();
    const revNum   = revisionRows.length ? Number(revisionRows[0].n) : 0;
    const revLabel = `R${revNum}`;

    const lineRows  = (lineDao.list(subId).rows) || [];
    const comments  = (responseDao.listForSubmittal(subId).rows || []).slice(0, 10);
    const branding  = brandingResolver.resolve(subId);

    const data = {
      generatedAt:       _fmtTimestamp(new Date()),
      subsidiaryName:    branding.name,
      subsidiaryAddress: branding.address,
      subsidiaryLogo:    branding.logoUrl,
      projectName:       header.project_name || '',
      submittalNumber:   header.sub_number || '',
      title:             header.title || '',
      revisionLabel:     revLabel,
      specSection:       header.spec_section || '',
      type:              header.type_name || '',
      status:            header.status_name || '',
      dueDate:           _fmtDate(header.due_date),
      ballInCourt:       header.bic_name || '',
      vendor:            header.vendor_name || '',
      lines:             _formatLines(lineRows),
      recentComments:    _formatComments(comments)
    };

    const renderer = render.create();
    renderer.templateContent = file.load({ id: TEMPLATE_PATHS.SUBMITTAL_EXPORT }).getContents();
    renderer.addCustomDataSource({
      format: render.DataSource.OBJECT,
      alias:  'record',
      data:   data
    });
    const pdfFile = renderer.renderAsPdf();
    pdfFile.name   = `Submittal-${header.sub_number || subId}-${revLabel}-export.pdf`;
    pdfFile.folder = _resolveGeneratedFolderId();
    const fileId   = pdfFile.save();
    _attachGeneratedFile(subId, Number(header.current_rev_id) || 0, fileId, pdfFile.name, 'generated_submittal_pdf');

    return {
      fileId:          Number(fileId),
      fileName:        pdfFile.name,
      submittalNumber: header.sub_number || '',
      revisionLabel:   revLabel
    };
  };

  // _attachGeneratedFile is exported for tests only — it stays an internal
  // helper of the three render paths.
  return { renderCloseout, renderTransmittalCover, renderSubmittalExport, _attachGeneratedFile };
});