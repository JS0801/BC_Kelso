/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 *
 * RMR Budget Overage Client Script
 *
 * UI validation for Purchase Orders and Vendor Bills.
 */
define(['N/currentRecord', 'N/search', 'N/ui/dialog', 'N/log'], function (currentRecord, search, dialog, log) {
    'use strict';

    var ACTION_WARN_ONLY = '1';
    var ACTION_HARD_STOP = '2';

    var BC_PROJECT_FIELD = 'cseg_bc_project';
    var BC_COST_CODE_FIELD = 'cseg_bc_cost_code';

    var PREF_RECORD_TYPE = 'customrecord_bc_proj_adv_pref';
    var PREF_PROJECT_FIELD = 'custrecord_bc_proj_adv_project';
    var PREF_UNLOCK_BUDGET_FIELD = 'custrecord_bc_proj_adv_unlock_budget';
    var PREF_WARNING_PERCENT_FIELD = 'custrecord_bc_budget_warn_pct';
    var PREF_WARNING_ACTION_FIELD = 'custrecord_bc_budget_warn_action';
    var PREF_OVER_BUDGET_ACTION_FIELD = 'custrecord_bc_budget_over_action';

    var BUDGET_RECORD_TYPE = 'customrecord_bc_budget_item';
    var BUDGET_PROJECT_FIELD = 'custrecord_bc_budget_project';
    var BUDGET_COST_CODE_FIELD = 'custrecord_bc_budget_code';
    var BUDGET_COST_TYPE_FIELD = 'custrecord_bc_budget_cost_type';
    var BUDGET_CURRENT_FIELD = 'custrecord_bc_budget_estimate';
    var BUDGET_ORIGINAL_FIELD = 'custrecord_bc_budget_estimate';

    var DEFAULT_WARNING_PERCENT = 85;
    var DEFAULT_WARNING_ACTION = ACTION_WARN_ONLY;
    var DEFAULT_OVER_BUDGET_ACTION = ACTION_HARD_STOP;

    var prefsByProject = {};
    var budgetByKey = {};
    var itemAccountByItem = {};
    var costsByKey = {};

    function validateLine(context) {
        try {
            var rec = context.currentRecord || currentRecord.get();
            if (!isTargetRecord(rec) || !isTargetSublist(context.sublistId)) {
                return true;
            }

            var line = getCurrentLine(rec, context.sublistId);
            if (!line) {
                return true;
            }

            line.amount = line.amount + getOtherUnsavedAmount(rec, context.sublistId, line);
            return handleBudgetResult(checkBudget(rec, line));
        } catch (e) {
            log.error('RMR Budget Client validateLine', e.message);
            return true;
        }
    }

    function saveRecord(context) {
        try {
            var rec = context.currentRecord || currentRecord.get();
            if (!isTargetRecord(rec)) {
                return true;
            }

            var groups = groupLines(rec);
            var messages = [];
            var blockSave = false;

            Object.keys(groups).forEach(function (key) {
                var result = checkBudget(rec, groups[key]);
                if (!result) {
                    return;
                }

                messages.push(result.message);
                if (result.action === ACTION_HARD_STOP) {
                    blockSave = true;
                }
            });

            if (messages.length) {
                showMessage(blockSave ? 'Budget Over Current Budget' : 'Budget Warning', messages.join('\n\n'));
            }

            return !blockSave;
        } catch (e) {
            log.error('RMR Budget Client saveRecord', e.message);
            return true;
        }
    }

    function checkBudget(rec, line) {
        var prefs = getPreferences(line.projectId);
        if (prefs.unlockBudget) {
            return null;
        }

        var currentBudget = getCurrentBudget(line.projectId, line.costCodeId, line.costTypeId);
        var existingCost = getProjectCost(rec.type, line.projectId, line.costCodeId, line.costTypeId, rec.id);
        var thisTransactionCost = getCurrentTransactionCost(rec, line);
        var totalAfterThisTransaction = existingCost + thisTransactionCost;
        var usedPercent = currentBudget > 0 ? (totalAfterThisTransaction / currentBudget) * 100 : 101;

        if (totalAfterThisTransaction > currentBudget) {
            return buildResult('Over Current Budget', prefs.overBudgetAction, line, currentBudget, existingCost, totalAfterThisTransaction, usedPercent);
        }

        if (usedPercent >= prefs.warningPercent) {
            return buildResult('Near Current Budget', prefs.warningAction, line, currentBudget, existingCost, totalAfterThisTransaction, usedPercent);
        }

        return null;
    }

    function buildResult(reason, action, line, currentBudget, existingCost, totalAfterThisTransaction, usedPercent) {
        return {
            action: action,
            message: [
                reason,
                'Project: ' + line.projectText,
                'Cost Code: ' + line.costCodeText,
                'Cost Type: ' + line.costTypeText,
                'Current Budget: ' + formatCurrency(currentBudget),
                'Existing Cost: ' + formatCurrency(existingCost),
                'This Transaction: ' + formatCurrency(totalAfterThisTransaction - existingCost),
                'Total After This Transaction: ' + formatCurrency(totalAfterThisTransaction) + ' (' + usedPercent.toFixed(1) + '%)',
                'Action: ' + (action === ACTION_HARD_STOP ? 'Hard Stop' : 'Warn Only')
            ].join('\n')
        };
    }

    function handleBudgetResult(result) {
        if (!result) {
            return true;
        }

        showMessage(result.action === ACTION_HARD_STOP ? 'Budget Over Current Budget' : 'Budget Warning', result.message);
        return result.action !== ACTION_HARD_STOP;
    }

    function getPreferences(projectId) {
        if (prefsByProject[projectId]) {
            return prefsByProject[projectId];
        }

        var prefs = {
            unlockBudget: false,
            warningPercent: DEFAULT_WARNING_PERCENT,
            warningAction: DEFAULT_WARNING_ACTION,
            overBudgetAction: DEFAULT_OVER_BUDGET_ACTION
        };

        var warningPercentCol = search.createColumn({ name: PREF_WARNING_PERCENT_FIELD });
        var warningActionCol = search.createColumn({ name: PREF_WARNING_ACTION_FIELD });
        var overBudgetActionCol = search.createColumn({ name: PREF_OVER_BUDGET_ACTION_FIELD });
        var unlockBudgetCol = search.createColumn({ name: PREF_UNLOCK_BUDGET_FIELD });

        var rows = search.create({
            type: PREF_RECORD_TYPE,
            filters: [
                [PREF_PROJECT_FIELD, 'anyof', projectId],
                'AND',
                ['isinactive', 'is', 'F']
            ],
            columns: [warningPercentCol, warningActionCol, overBudgetActionCol, unlockBudgetCol]
        }).run().getRange({ start: 0, end: 1 });

        if (rows && rows.length) {
            prefs.unlockBudget = rows[0].getValue(unlockBudgetCol) === true || rows[0].getValue(unlockBudgetCol) === 'T';
            prefs.warningPercent = toPercent(rows[0].getValue(warningPercentCol)) || DEFAULT_WARNING_PERCENT;
            prefs.warningAction = String(rows[0].getValue(warningActionCol) || DEFAULT_WARNING_ACTION);
            prefs.overBudgetAction = String(rows[0].getValue(overBudgetActionCol) || DEFAULT_OVER_BUDGET_ACTION);
        }

        prefsByProject[projectId] = prefs;
        return prefs;
    }

    function getCurrentBudget(projectId, costCodeId, costTypeId) {
        var key = [projectId, costCodeId, costTypeId].join('|');
        if (budgetByKey[key] !== undefined) {
            return budgetByKey[key];
        }

        var currentBudgetCol = search.createColumn({ name: BUDGET_CURRENT_FIELD });
        var originalBudgetCol = search.createColumn({ name: BUDGET_ORIGINAL_FIELD });

        var rows = search.create({
            type: BUDGET_RECORD_TYPE,
            filters: [
                [BUDGET_PROJECT_FIELD, 'anyof', projectId],
                'AND',
                [BUDGET_COST_CODE_FIELD, 'anyof', costCodeId],
                'AND',
                [BUDGET_COST_TYPE_FIELD, 'anyof', costTypeId],
                'AND',
                ['isinactive', 'is', 'F']
            ],
            columns: [currentBudgetCol, originalBudgetCol]
        }).run().getRange({ start: 0, end: 1 });

        var currentBudget = 0;
        if (rows && rows.length) {
            currentBudget = toNumber(rows[0].getValue(currentBudgetCol)) || toNumber(rows[0].getValue(originalBudgetCol));
        }

        budgetByKey[key] = currentBudget;
        return currentBudget;
    }

    function getProjectCost(recordType, projectId, costCodeId, costTypeId, currentTransactionId) {
        var key = [recordType, projectId, costCodeId, costTypeId, currentTransactionId || 'new'].join('|');
        if (costsByKey[key] !== undefined) {
            return costsByKey[key];
        }

        var actualBillExcludeId = recordType === 'vendorbill' ? currentTransactionId : null;
        var purchaseOrderExcludeId = recordType === 'purchaseorder' ? currentTransactionId : null;
        var linkedBillCreatedFromExcludeId = recordType === 'purchaseorder' ? currentTransactionId : null;

        var actualBills = getTransactionAmount('VendBill', projectId, costCodeId, costTypeId, actualBillExcludeId, false);
        var openPurchaseOrders = getTransactionAmount('PurchOrd', projectId, costCodeId, costTypeId, purchaseOrderExcludeId, true);
        var billsCreatedFromPurchaseOrders = getBillsCreatedFromPurchaseOrders(projectId, costCodeId, costTypeId, null, linkedBillCreatedFromExcludeId);
        var committedCost = Math.max(0, openPurchaseOrders - billsCreatedFromPurchaseOrders);

        costsByKey[key] = actualBills + committedCost;
        return costsByKey[key];
    }

    function getCurrentTransactionCost(rec, line) {
        if (rec.type !== 'purchaseorder' || !rec.id) {
            return line.amount;
        }

        var billedAgainstCurrentPo = getBillsCreatedFromPurchaseOrders(
            line.projectId,
            line.costCodeId,
            line.costTypeId,
            rec.id,
            null
        );

        return Math.max(0, line.amount - billedAgainstCurrentPo);
    }

    function getTransactionAmount(type, projectId, costCodeId, costTypeId, excludeTransactionId, openPoOnly) {
        var amountCol = search.createColumn({
            name: 'amount',
            summary: search.Summary.SUM
        });

        var filters = [
            ['type', 'anyof', type],
            'AND',
            ['mainline', 'is', 'F'],
            'AND',
            ['taxline', 'is', 'F'],
            'AND',
            ['line.' + BC_PROJECT_FIELD, 'anyof', projectId],
            'AND',
            ['line.' + BC_COST_CODE_FIELD, 'anyof', costCodeId],
            'AND',
            ['account', 'anyof', costTypeId]
        ];

        if (excludeTransactionId) {
            filters.push('AND', ['internalid', 'noneof', String(excludeTransactionId)]);
        }

        if (openPoOnly) {
            filters.push('AND', ['status', 'noneof', 'PurchOrd:G', 'PurchOrd:H']);
        }

        var rows = search.create({
            type: search.Type.TRANSACTION,
            filters: filters,
            columns: [amountCol]
        }).run().getRange({ start: 0, end: 1 });

        return rows && rows.length ? Math.abs(toNumber(rows[0].getValue(amountCol))) : 0;
    }

    function getBillsCreatedFromPurchaseOrders(projectId, costCodeId, costTypeId, createdFromId, excludeCreatedFromId) {
        var amountCol = search.createColumn({
            name: 'amount',
            summary: search.Summary.SUM
        });

        var filters = [
            ['type', 'anyof', 'VendBill'],
            'AND',
            ['mainline', 'is', 'F'],
            'AND',
            ['taxline', 'is', 'F'],
            'AND',
            ['line.' + BC_PROJECT_FIELD, 'anyof', projectId],
            'AND',
            ['line.' + BC_COST_CODE_FIELD, 'anyof', costCodeId],
            'AND',
            ['account', 'anyof', costTypeId]
        ];

        if (createdFromId) {
            filters.push('AND', ['createdfrom', 'anyof', String(createdFromId)]);
        } else {
            filters.push('AND', ['createdfrom', 'noneof', '@NONE@']);
        }

        if (excludeCreatedFromId) {
            filters.push('AND', ['createdfrom', 'noneof', String(excludeCreatedFromId)]);
        }

        var rows = search.create({
            type: search.Type.TRANSACTION,
            filters: filters,
            columns: [amountCol]
        }).run().getRange({ start: 0, end: 1 });

        return rows && rows.length ? Math.abs(toNumber(rows[0].getValue(amountCol))) : 0;
    }

    function groupLines(rec) {
        var groups = {};

        ['item', 'expense'].forEach(function (sublistId) {
            var count = getLineCount(rec, sublistId);
            for (var i = 0; i < count; i++) {
                var line = getLine(rec, sublistId, i);
                if (!line) {
                    continue;
                }

                var key = [line.projectId, line.costCodeId, line.costTypeId].join('|');
                if (!groups[key]) {
                    groups[key] = line;
                    groups[key].amount = 0;
                }

                groups[key].amount += line.amount;
            }
        });

        return groups;
    }

    function getOtherUnsavedAmount(rec, currentSublistId, currentLine) {
        var total = 0;
        var currentLineIndex = rec.getCurrentSublistIndex({ sublistId: currentSublistId });

        ['item', 'expense'].forEach(function (sublistId) {
            var count = getLineCount(rec, sublistId);
            for (var i = 0; i < count; i++) {
                if (sublistId === currentSublistId && i === currentLineIndex) {
                    continue;
                }

                var line = getLine(rec, sublistId, i);
                if (
                    line &&
                    line.projectId === currentLine.projectId &&
                    line.costCodeId === currentLine.costCodeId &&
                    line.costTypeId === currentLine.costTypeId
                ) {
                    total += line.amount;
                }
            }
        });

        return total;
    }

    function getCurrentLine(rec, sublistId) {
        var projectId = rec.getCurrentSublistValue({ sublistId: sublistId, fieldId: BC_PROJECT_FIELD }) || rec.getValue({ fieldId: BC_PROJECT_FIELD });
        var costCodeId = rec.getCurrentSublistValue({ sublistId: sublistId, fieldId: BC_COST_CODE_FIELD });
        var costType = getCurrentCostType(rec, sublistId);
        var amount = getCurrentAmount(rec, sublistId);

        if (!projectId || !costCodeId || !costType.value || amount <= 0) {
            return null;
        }

        return {
            projectId: String(projectId),
            projectText: rec.getCurrentSublistText({ sublistId: sublistId, fieldId: BC_PROJECT_FIELD }) || rec.getText({ fieldId: BC_PROJECT_FIELD }) || String(projectId),
            costCodeId: String(costCodeId),
            costCodeText: rec.getCurrentSublistText({ sublistId: sublistId, fieldId: BC_COST_CODE_FIELD }) || String(costCodeId),
            costTypeId: String(costType.value),
            costTypeText: costType.text || String(costType.value),
            amount: amount
        };
    }

    function getLine(rec, sublistId, lineIndex) {
        var projectId = rec.getSublistValue({ sublistId: sublistId, fieldId: BC_PROJECT_FIELD, line: lineIndex }) || rec.getValue({ fieldId: BC_PROJECT_FIELD });
        var costCodeId = rec.getSublistValue({ sublistId: sublistId, fieldId: BC_COST_CODE_FIELD, line: lineIndex });
        var costType = getLineCostType(rec, sublistId, lineIndex);
        var amount = getAmount(rec, sublistId, lineIndex);

        if (!projectId || !costCodeId || !costType.value || amount <= 0) {
            return null;
        }

        return {
            projectId: String(projectId),
            projectText: rec.getSublistText({ sublistId: sublistId, fieldId: BC_PROJECT_FIELD, line: lineIndex }) || rec.getText({ fieldId: BC_PROJECT_FIELD }) || String(projectId),
            costCodeId: String(costCodeId),
            costCodeText: rec.getSublistText({ sublistId: sublistId, fieldId: BC_COST_CODE_FIELD, line: lineIndex }) || String(costCodeId),
            costTypeId: String(costType.value),
            costTypeText: costType.text || String(costType.value),
            amount: amount
        };
    }

    function getCurrentCostType(rec, sublistId) {
        if (sublistId === 'expense') {
            return {
                value: rec.getCurrentSublistValue({ sublistId: sublistId, fieldId: 'account' }),
                text: rec.getCurrentSublistText({ sublistId: sublistId, fieldId: 'account' })
            };
        }

        return getItemExpenseAccount(rec.getCurrentSublistValue({ sublistId: sublistId, fieldId: 'item' }));
    }

    function getLineCostType(rec, sublistId, lineIndex) {
        if (sublistId === 'expense') {
            return {
                value: rec.getSublistValue({ sublistId: sublistId, fieldId: 'account', line: lineIndex }),
                text: rec.getSublistText({ sublistId: sublistId, fieldId: 'account', line: lineIndex })
            };
        }

        return getItemExpenseAccount(rec.getSublistValue({ sublistId: sublistId, fieldId: 'item', line: lineIndex }));
    }

    function getItemExpenseAccount(itemId) {
        if (!itemId) {
            return { value: '', text: '' };
        }

        if (itemAccountByItem[itemId]) {
            return itemAccountByItem[itemId];
        }

        var lookup = search.lookupFields({
            type: search.Type.ITEM,
            id: itemId,
            columns: ['expenseaccount']
        });

        itemAccountByItem[itemId] = lookup.expenseaccount && lookup.expenseaccount.length
            ? { value: lookup.expenseaccount[0].value, text: lookup.expenseaccount[0].text }
            : { value: '', text: '' };

        return itemAccountByItem[itemId];
    }

    function getCurrentAmount(rec, sublistId) {
        return Math.abs(toNumber(rec.getCurrentSublistValue({ sublistId: sublistId, fieldId: 'amount' })));
    }

    function getAmount(rec, sublistId, lineIndex) {
        return Math.abs(toNumber(rec.getSublistValue({ sublistId: sublistId, fieldId: 'amount', line: lineIndex })));
    }

    function getLineCount(rec, sublistId) {
        try {
            return rec.getLineCount({ sublistId: sublistId }) || 0;
        } catch (e) {
            return 0;
        }
    }

    function isTargetRecord(rec) {
        return rec && (rec.type === 'purchaseorder' || rec.type === 'vendorbill');
    }

    function isTargetSublist(sublistId) {
        return sublistId === 'item' || sublistId === 'expense';
    }

    function toNumber(value) {
        return Number(value) || 0;
    }

    function toPercent(value) {
        var percent = Number(String(value || '').replace('%', '')) || 0;
        return percent > 0 && percent < 1 ? percent * 100 : percent;
    }

    function formatCurrency(value) {
        return '$' + toNumber(value).toFixed(2);
    }

    function showMessage(title, message) {
        if (typeof window !== 'undefined' && window.alert) {
            window.alert(title + '\n\n' + message);
            return;
        }

        dialog.alert({
            title: title,
            message: message.replace(/\n/g, '<br>')
        });
    }

    return {
        validateLine: validateLine,
        saveRecord: saveRecord
    };
});
