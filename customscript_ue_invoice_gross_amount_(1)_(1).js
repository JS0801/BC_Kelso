/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Script ID:     customscript_ue_invoice_gross_amount
 * Deployment ID: customdeploy_ue_invoice_gross_amount
 *
 * On invoice creation from an SO, populates:
 *   custcol_bc_gross_quantity    ← SO quantity
 *   custcol_bc_sov_dollars_billed ← SO amount
 */
define(['N/record', 'N/log'],
(record, log) => {

    const beforeSubmit = (scriptContext) => {
        try {
          //  if (scriptContext.type !== scriptContext.UserEventType.CREATE) return;

            const rec = scriptContext.newRecord;

            const createdFrom = rec.getValue({ fieldId: 'createdfrom' });
            if (!createdFrom) {
                log.audit({ title: 'SKIP', details: 'Invoice not created from an SO.' });
                return;
            }
            log.audit({ title: 'Created From SO ID', details: createdFrom });

            const so = record.load({
                type: record.Type.SALES_ORDER,
                id:   createdFrom
            });

            const isBlueCollarContract = so.getValue({ fieldId: 'custbody_bc_is_bluecollar_contract' });
            if (isBlueCollarContract) {
                log.audit({ title: 'SKIP', details: 'SO is a Blue Collar contract — skipped.' });
                return;
            }

            // Build map of SO lines: key = line number, value = quantity + amount
            const soLineCount = so.getLineCount({ sublistId: 'item' });
            const soLineMap   = [];

            for (let i = 0; i < soLineCount; i++) {
                const lineNum = so.getSublistValue({ sublistId: 'item', fieldId: 'line',     line: i });
                const qty     = so.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i });
                const amount  = so.getSublistValue({ sublistId: 'item', fieldId: 'amount',   line: i });

                soLineMap.push({ lineNum, qty, amount });
                log.audit({
                    title:   `SO Line ${i}`,
                    details: `LineNum: ${lineNum} | Qty: ${qty} | Amount: ${amount}`
                });
            }

            // Match invoice lines to SO lines via orderline and set gross fields
            const invLineCount = rec.getLineCount({ sublistId: 'item' });

            for (let i = 0; i < invLineCount; i++) {
                const invItemId  = rec.getSublistValue({ sublistId: 'item', fieldId: 'item',      line: i });
                const invLineNum = rec.getSublistValue({ sublistId: 'item', fieldId: 'orderline', line: i });

                const match = soLineMap.find(l => String(l.lineNum) === String(invLineNum));

                if (match) {
                    rec.setSublistValue({
                        sublistId: 'item',
                        fieldId:   'custcol_bc_gross_quantity',
                        line:      i,
                        value:     parseFloat(match.qty)
                    });
                    rec.setSublistValue({
                        sublistId: 'item',
                        fieldId:   'custcol_bc_sov_dollars_billed',
                        line:      i,
                        value:     parseFloat(match.amount).toFixed(2)
                    });
                    log.audit({
                        title:   `Invoice Line ${i} Set`,
                        details: `Item: ${invItemId} | GrossQty: ${match.qty} | GrossAmt: ${match.amount}`
                    });
                } else {
                    log.audit({
                        title:   `Invoice Line ${i} No Match`,
                        details: `Item: ${invItemId} | orderline: ${invLineNum}`
                    });
                }
            }

        } catch (e) {
            log.error({ title: 'FATAL ERROR', details: `${e.name}: ${e.message}\n${e.stack}` });
        }
    };
  

    return { beforeSubmit };
});