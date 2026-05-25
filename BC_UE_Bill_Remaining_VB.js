/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/log'], (record, log) => {

    const REMAINING_QTY_FIELD_ID = 'custcol_remaining_pty';

    function beforeLoad(context) {
        try {
            if (context.type !== context.UserEventType.CREATE) {
                return;
            }

            const request = context.request;
            if (!request || request.parameters.custparam_bill_remaining !== 'T') {
                return;
            }

            const billRecord = context.newRecord;

            const poId = request.parameters.custparam_poid;

            if (!poId) {
                log.debug({
                    title: 'Bill Remaining',
                    details: 'No PO id found in request parameters.'
                });
                return;
            }

            log.debug({
                title: 'Bill Remaining',
                details: 'PO id received from request: ' + poId
            });

            const poRecord = record.load({
                type: record.Type.PURCHASE_ORDER,
                id: poId,
                isDynamic: false
            });

            const poLineCount = poRecord.getLineCount({
                sublistId: 'item'
            });

            const remainingQtyByPoLine = {};

            for (let i = 0; i < poLineCount; i++) {
                const poLineNumber = poRecord.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'line',
                    line: i
                });

                const remainingQty = poRecord.getSublistValue({
                    sublistId: 'item',
                    fieldId: REMAINING_QTY_FIELD_ID,
                    line: i
                });

                remainingQtyByPoLine[String(poLineNumber)] = remainingQty;
            }

            log.debug({
                title: 'Bill Remaining - PO map',
                details: JSON.stringify(remainingQtyByPoLine)
            });

            const billLineCount = billRecord.getLineCount({
                sublistId: 'item'
            });

            for (let i = 0; i < billLineCount; i++) {
                const orderLine = billRecord.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'orderline',
                    line: i
                });

                log.debug({
                    title: 'Bill line mapping',
                    details: 'Bill line ' + i + ', orderLine=' + orderLine
                });

                if (!orderLine) {
                    continue;
                }

                const remainingQty = remainingQtyByPoLine[String(orderLine)];

                if (remainingQty === '' || remainingQty == null) {
                    continue;
                }

                const lineRate = billRecord.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'rate',
                    line: i
                });
                const numericRemainingQty = Number(remainingQty);

                if (isNaN(numericRemainingQty) || numericRemainingQty < 0) {
                    continue;
                }

                billRecord.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    line: i,
                    value: numericRemainingQty
                });

                billRecord.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'amount',
                    line: i,
                    value: (lineRate * numericRemainingQty)
                });
            }

        } catch (e) {
            log.error({
                title: 'Bill Remaining beforeLoad error',
                details: e
            });
        }
    }

    return {
        beforeLoad: beforeLoad
    };
});