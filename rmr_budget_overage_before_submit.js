/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 *
 * RMR Budget Overage Before Submit
 *
 * Server-side hard stops for Purchase Orders and Vendor Bills.
 */
define(['N/search', 'N/error', 'N/log'], function (search, error, log) {
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
    var BUDGET_ESTIMATE_FIELD = 'custrecord_bc_budget_estimate';

    var DEFAULT_WARNING_PERCENT = 85;
    var DEFAULT_WARNING_ACTION = ACTION_WARN_ONLY;
    var DEFAULT_OVER_BUDGET_ACTION = ACTION_HARD_STOP;
    var VALIDATION_ERROR_NAME = 'RMR_BUDGET_VALIDATION';

    var prefsByProject = {};
    var budgetByKey = {};
    var itemAccountByItem = {};
    var costsByKey = {};

    function beforeSubmit(context) {
        if (!isCreateEditOrCopy(context)) {
            return;
        }

        var rec = context.newRecord;
        if (!isTargetRecord(rec)) {
            return;
        }

        try {
            resetRuntimeCaches();

            var groups = groupLines(rec);
            var hardStops = [];

            Object.keys(groups).forEach(function (key) {
                var result = checkBudget(rec, groups[key]);
                if (result && result.action === ACTION_HARD_STOP) {
                    hardStops.push(result);
                }
            });

            if (hardStops.length) {
                throw error.create({
                    name: VALIDATION_ERROR_NAME,
                    message: buildErrorMessage(hardStops),
                    notifyOff: false
                });
            }
        } catch (e) {
            if (e.name === VALIDATION_ERROR_NAME) {
                throw e;
            }

            log.error({
                title: 'RMR Budget Before Submit',
                details: e.message + '\n' + (e.stack || '')
            });
        }
    }

    function resetRuntimeCaches() {
        prefsByProject = {};
        budgetByKey = {};
        itemAccountByItem = {};
        costsByKey = {};
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
            reason: reason,
            action: action,
            lineNumbers: line.lineNumbers || [],
            projectText: line.projectText,
            costCodeText: line.costCodeText,
            costTypeText: line.costTypeText,
            currentBudget: currentBudget,
            existingCost: existingCost,
            thisTransactionCost: totalAfterThisTransaction - existingCost,
            totalAfterThisTransaction: totalAfterThisTransaction,
            usedPercent: usedPercent
        };
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

        var estimateCol = search.createColumn({ name: BUDGET_ESTIMATE_FIELD });

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
            columns: [estimateCol]
        }).run().getRange({ start: 0, end: 1 });

        var currentBudget = 0;
        if (rows && rows.length) {
            currentBudget = toNumber(rows[0].getValue(estimateCol));
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
                    groups[key].lineNumbers = [];
                }

                groups[key].amount += line.amount;
                groups[key].lineNumbers.push(i + 1);
            }
        });

        return groups;
    }

    function getLine(rec, sublistId, lineIndex) {
        var projectId = getSublistValue(rec, sublistId, BC_PROJECT_FIELD, lineIndex) || getValue(rec, BC_PROJECT_FIELD);
        var costCodeId = getSublistValue(rec, sublistId, BC_COST_CODE_FIELD, lineIndex);
        var costType = getLineCostType(rec, sublistId, lineIndex);
        var amount = getAmount(rec, sublistId, lineIndex);

        if (!projectId || !costCodeId || !costType.value || amount <= 0) {
            return null;
        }

        return {
            projectId: String(projectId),
            projectText: getSublistText(rec, sublistId, BC_PROJECT_FIELD, lineIndex) || getText(rec, BC_PROJECT_FIELD) || String(projectId),
            costCodeId: String(costCodeId),
            costCodeText: getSublistText(rec, sublistId, BC_COST_CODE_FIELD, lineIndex) || String(costCodeId),
            costTypeId: String(costType.value),
            costTypeText: costType.text || String(costType.value),
            amount: amount
        };
    }

    function getLineCostType(rec, sublistId, lineIndex) {
        if (sublistId === 'expense') {
            return {
                value: getSublistValue(rec, sublistId, 'account', lineIndex),
                text: getSublistText(rec, sublistId, 'account', lineIndex)
            };
        }

        return getItemExpenseAccount(getSublistValue(rec, sublistId, 'item', lineIndex));
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

    function getAmount(rec, sublistId, lineIndex) {
        return Math.abs(toNumber(getSublistValue(rec, sublistId, 'amount', lineIndex)));
    }

    function getLineCount(rec, sublistId) {
        try {
            return rec.getLineCount({ sublistId: sublistId }) || 0;
        } catch (e) {
            return 0;
        }
    }

    function getSublistValue(rec, sublistId, fieldId, lineIndex) {
        try {
            return rec.getSublistValue({
                sublistId: sublistId,
                fieldId: fieldId,
                line: lineIndex
            });
        } catch (e) {
            return '';
        }
    }

    function getSublistText(rec, sublistId, fieldId, lineIndex) {
        try {
            return rec.getSublistText({
                sublistId: sublistId,
                fieldId: fieldId,
                line: lineIndex
            });
        } catch (e) {
            return '';
        }
    }

    function getValue(rec, fieldId) {
        try {
            return rec.getValue({ fieldId: fieldId });
        } catch (e) {
            return '';
        }
    }

    function getText(rec, fieldId) {
        try {
            return rec.getText({ fieldId: fieldId });
        } catch (e) {
            return '';
        }
    }

    function isCreateEditOrCopy(context) {
        return [
            context.UserEventType.CREATE,
            context.UserEventType.EDIT,
            context.UserEventType.COPY
        ].indexOf(context.type) !== -1;
    }

    function isTargetRecord(rec) {
        return rec && (rec.type === 'purchaseorder' || rec.type === 'vendorbill');
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

    function buildErrorMessage(hardStops) {
        var lines = [
            'BUDGET HARD STOP - This transaction cannot be saved.',
            ''
        ];

        hardStops.forEach(function (stop) {
            lines.push(stop.reason);
            lines.push('Lines: ' + stop.lineNumbers.join(', '));
            lines.push('Project: ' + stop.projectText);
            lines.push('Cost Code: ' + stop.costCodeText);
            lines.push('Cost Type: ' + stop.costTypeText);
            lines.push('Current Budget: ' + formatCurrency(stop.currentBudget));
            lines.push('Existing Cost: ' + formatCurrency(stop.existingCost));
            lines.push('This Transaction: ' + formatCurrency(stop.thisTransactionCost));
            lines.push('Total After This Transaction: ' + formatCurrency(stop.totalAfterThisTransaction) + ' (' + stop.usedPercent.toFixed(1) + '%)');
            lines.push('');
        });

        return lines.join('\n');
    }

    return {
        beforeSubmit: beforeSubmit
    };
});
