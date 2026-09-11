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

    var LOG_TITLE = 'RMR Budget Client';

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

    var CHANGE_REQUEST_BUDGET_ITEM_RECORD_TYPE = 'customrecord_bc_change_req_budget_item';
    var CHANGE_REQUEST_BUDGET_ITEM_FIELD = 'custrecord_bc_budget_item';
    var CHANGE_REQUEST_STATUS_FIELD = 'custrecord_bc_chg_request_b_item_status';
    var CHANGE_REQUEST_PROPOSED_CHANGE_FIELD = 'custrecord_bc_proposed_change';
    var CHANGE_REQUEST_APPROVED_STATUS = '1';

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

            logDebug('validateLine start', {
                recordType: rec.type,
                recordId: rec.id || 'new',
                sublistId: context.sublistId
            });

            var line = getCurrentLine(rec, context.sublistId);
            if (!line) {
                logDebug('validateLine skipped', {
                    sublistId: context.sublistId,
                    reason: 'Missing project, cost code, cost type, or positive amount'
                });
                return true;
            }

            var otherUnsavedAmount = getOtherUnsavedAmount(rec, context.sublistId, line);
            line.amount = line.amount + otherUnsavedAmount;

            logDebug('validateLine budget bucket', {
                line: summarizeLine(line),
                otherUnsavedAmount: otherUnsavedAmount
            });

            var result = checkBudget(rec, line);
            logDebug('validateLine decision', result ? summarizeResult(result) : {
                line: summarizeLine(line),
                decision: 'Allow',
                reason: 'Under configured budget threshold'
            });

            return handleBudgetResult(result);
        } catch (e) {
            logError('validateLine error', e);
            return true;
        }
    }

    function saveRecord(context) {
        try {
            var rec = context.currentRecord || currentRecord.get();
            if (!isTargetRecord(rec)) {
                return true;
            }

            logDebug('saveRecord start', {
                recordType: rec.type,
                recordId: rec.id || 'new'
            });

            var groups = groupLines(rec);
            var groupKeys = Object.keys(groups);
            var messages = [];
            var blockSave = false;

            logDebug('saveRecord grouped lines', {
                groupCount: groupKeys.length,
                groups: groupKeys
            });

            groupKeys.forEach(function (key) {
                var result = checkBudget(rec, groups[key]);
                if (!result) {
                    logDebug('saveRecord group allowed', {
                        line: summarizeLine(groups[key]),
                        reason: 'Under configured budget threshold'
                    });
                    return;
                }

                logDebug('saveRecord group decision', summarizeResult(result));
                messages.push(result.message);
                if (result.action === ACTION_HARD_STOP) {
                    blockSave = true;
                }
            });

            if (messages.length) {
                showMessage(blockSave ? 'Budget Over Current Budget' : 'Budget Warning', messages.join('\n\n'));
            }

            logDebug('saveRecord finish', {
                messageCount: messages.length,
                blockSave: blockSave
            });

            return !blockSave;
        } catch (e) {
            logError('saveRecord error', e);
            return true;
        }
    }

    function checkBudget(rec, line) {
        var prefs = getPreferences(line.projectId);
        if (prefs.unlockBudget) {
            logDebug('checkBudget skipped', {
                line: summarizeLine(line),
                reason: 'Unlock budget is enabled on project preferences'
            });
            return null;
        }

        var currentBudget = getCurrentBudget(line.projectId, line.costCodeId, line.costTypeId);
        var existingCost = getProjectCost(rec.type, line.projectId, line.costCodeId, line.costTypeId, rec.id);
        var thisTransactionCost = getCurrentTransactionCost(rec, line);
        var totalAfterThisTransaction = existingCost + thisTransactionCost;
        var usedPercent = currentBudget > 0 ? (totalAfterThisTransaction / currentBudget) * 100 : 101;

        logDebug('checkBudget amounts', {
            line: summarizeLine(line),
            currentBudget: currentBudget,
            existingCost: existingCost,
            thisTransactionCost: thisTransactionCost,
            totalAfterThisTransaction: totalAfterThisTransaction,
            usedPercent: usedPercent,
            warningPercent: prefs.warningPercent,
            warningAction: actionName(prefs.warningAction),
            overBudgetAction: actionName(prefs.overBudgetAction)
        });

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
            projectId: line.projectId,
            projectText: line.projectText,
            costCodeId: line.costCodeId,
            costCodeText: line.costCodeText,
            costTypeId: line.costTypeId,
            costTypeText: line.costTypeText,
            amount: line.amount,
            currentBudget: currentBudget,
            existingCost: existingCost,
            thisTransactionCost: totalAfterThisTransaction - existingCost,
            totalAfterThisTransaction: totalAfterThisTransaction,
            usedPercent: usedPercent,
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

        logDebug('show budget message', summarizeResult(result));
        showMessage(result.action === ACTION_HARD_STOP ? 'Budget Over Current Budget' : 'Budget Warning', result.message);
        return result.action !== ACTION_HARD_STOP;
    }

    function getPreferences(projectId) {
        if (prefsByProject[projectId]) {
            logDebug('preferences cache hit', {
                projectId: projectId,
                preferences: summarizePreferences(prefsByProject[projectId])
            });
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
            logDebug('preferences loaded', {
                projectId: projectId,
                preferences: summarizePreferences(prefs)
            });
        } else {
            logDebug('preferences missing - defaults used', {
                projectId: projectId,
                preferences: summarizePreferences(prefs)
            });
        }

        prefsByProject[projectId] = prefs;
        return prefs;
    }

    function getCurrentBudget(projectId, costCodeId, costTypeId) {
        var key = [projectId, costCodeId, costTypeId].join('|');
        if (budgetByKey[key] !== undefined) {
            return budgetByKey[key];
        }

        var budgetItemIdCol = search.createColumn({ name: 'internalid' });
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
            columns: [budgetItemIdCol, estimateCol]
        }).run().getRange({ start: 0, end: 1000 });

        var budgetItemIds = [];
        var baseEstimate = 0;
        var approvedChangeAmount = 0;
        var currentBudget = 0;

        if (rows && rows.length) {
            rows.forEach(function (row) {
                var budgetItemId = row.getValue(budgetItemIdCol) || row.id;
                if (budgetItemId) {
                    budgetItemIds.push(String(budgetItemId));
                }

                baseEstimate += toNumber(row.getValue(estimateCol));
            });

            approvedChangeAmount = getApprovedChangeAmount(budgetItemIds);
            currentBudget = baseEstimate + approvedChangeAmount;
        }

        logDebug('budget loaded', {
            budgetItemIds: budgetItemIds,
            budgetItemCount: budgetItemIds.length,
            projectId: projectId,
            costCodeId: costCodeId,
            costTypeId: costTypeId,
            budgetFieldId: BUDGET_ESTIMATE_FIELD,
            budgetRecordFound: !!(rows && rows.length),
            baseEstimate: baseEstimate,
            approvedChangeAmount: approvedChangeAmount,
            currentBudget: currentBudget
        });

        budgetByKey[key] = currentBudget;
        return currentBudget;
    }

    function getApprovedChangeAmount(budgetItemIds) {
        if (!budgetItemIds || !budgetItemIds.length) {
            return 0;
        }

        var proposedChangeCol = search.createColumn({
            name: CHANGE_REQUEST_PROPOSED_CHANGE_FIELD,
            summary: search.Summary.SUM
        });

        var rows = search.create({
            type: CHANGE_REQUEST_BUDGET_ITEM_RECORD_TYPE,
            filters: [
                [CHANGE_REQUEST_BUDGET_ITEM_FIELD, 'anyof', budgetItemIds],
                'AND',
                [CHANGE_REQUEST_STATUS_FIELD, 'anyof', CHANGE_REQUEST_APPROVED_STATUS]
            ],
            columns: [proposedChangeCol]
        }).run().getRange({ start: 0, end: 1 });

        var approvedChangeAmount = rows && rows.length ? toNumber(rows[0].getValue(proposedChangeCol)) : 0;

        logDebug('approved change requests loaded', {
            budgetItemIds: budgetItemIds,
            changeRequestRecordType: CHANGE_REQUEST_BUDGET_ITEM_RECORD_TYPE,
            changeRequestBudgetItemFieldId: CHANGE_REQUEST_BUDGET_ITEM_FIELD,
            changeRequestStatusFieldId: CHANGE_REQUEST_STATUS_FIELD,
            changeRequestStatusId: CHANGE_REQUEST_APPROVED_STATUS,
            proposedChangeFieldId: CHANGE_REQUEST_PROPOSED_CHANGE_FIELD,
            approvedChangeAmount: approvedChangeAmount
        });

        return approvedChangeAmount;
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

        logDebug('project cost loaded', {
            recordType: recordType,
            currentTransactionId: currentTransactionId || '',
            projectId: projectId,
            costCodeId: costCodeId,
            costTypeId: costTypeId,
            actualBills: actualBills,
            openPurchaseOrders: openPurchaseOrders,
            billsCreatedFromPurchaseOrders: billsCreatedFromPurchaseOrders,
            committedCost: committedCost,
            totalProjectCost: actualBills + committedCost
        });

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

        var thisTransactionCost = Math.max(0, line.amount - billedAgainstCurrentPo);

        logDebug('current transaction PO cost', {
            recordId: rec.id,
            lineAmount: line.amount,
            billedAgainstCurrentPo: billedAgainstCurrentPo,
            thisTransactionCost: thisTransactionCost
        });

        return thisTransactionCost;
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

    function summarizeLine(line) {
        return {
            projectId: line.projectId,
            projectText: line.projectText,
            costCodeId: line.costCodeId,
            costCodeText: line.costCodeText,
            costTypeId: line.costTypeId,
            costTypeText: line.costTypeText,
            amount: line.amount
        };
    }

    function summarizeResult(result) {
        return {
            reason: result.reason,
            actionId: result.action,
            actionText: actionName(result.action),
            projectId: result.projectId,
            projectText: result.projectText,
            costCodeId: result.costCodeId,
            costCodeText: result.costCodeText,
            costTypeId: result.costTypeId,
            costTypeText: result.costTypeText,
            currentBudget: result.currentBudget,
            existingCost: result.existingCost,
            thisTransactionCost: result.thisTransactionCost,
            totalAfterThisTransaction: result.totalAfterThisTransaction,
            usedPercent: result.usedPercent
        };
    }

    function summarizePreferences(prefs) {
        return {
            unlockBudget: prefs.unlockBudget,
            warningPercent: prefs.warningPercent,
            warningActionId: prefs.warningAction,
            warningActionText: actionName(prefs.warningAction),
            overBudgetActionId: prefs.overBudgetAction,
            overBudgetActionText: actionName(prefs.overBudgetAction)
        };
    }

    function actionName(action) {
        return action === ACTION_HARD_STOP ? 'Hard Stop' : 'Warn Only';
    }

    function logDebug(title, details) {
        writeLog('debug', title, details);
    }

    function logError(title, err) {
        writeLog('error', title, {
            message: err && err.message ? err.message : String(err),
            stack: err && err.stack ? err.stack : ''
        });
    }

    function writeLog(level, title, details) {
        try {
            log[level]({
                title: LOG_TITLE + ' | ' + title,
                details: stringify(details)
            });
        } catch (e) {
            // Logging should never affect transaction entry.
        }
    }

    function stringify(value) {
        if (typeof value === 'string') {
            return value;
        }

        try {
            return JSON.stringify(value);
        } catch (e) {
            return String(value);
        }
    }

    return {
        validateLine: validateLine,
        saveRecord: saveRecord
    };
});
