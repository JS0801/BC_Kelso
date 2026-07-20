/**
* @NApiVersion 2.x
* @NScriptType UserEventScript
* @NModuleScope SameAccount
*/
define(['N/ui/serverWidget', 'N/url', 'N/search'], function(ui, url, search) {

  function beforeLoad(context) {
    if (context.type === context.UserEventType.VIEW) {
      const Ralph_G_Degli = 15;
      var form = context.form;
      var current_rec = context.newRecord;
      var recordId = context.newRecord.id;
      var sub = current_rec.getValue('subsidiary');
      var bcProj = current_rec.getValue('cseg_bc_project');
      var custId = current_rec.getValue('entity');

      if (custId == 787592) {
        var scriptUrl1 = url.resolveScript({
          scriptId: 'customscript_bc_sl_print_wavier_afs',
          deploymentId: 'customdeploy_bc_sl_print_wavier_afs'
        });


        var buttonScript1 = "window.open('" + scriptUrl + "&recordid=" + recordId +"', '_blank');";

        form.addButton({
          id: 'custpage_my_button1',
          label: 'Print AFS Form',
          functionName: buttonScript1
        });
      }

      if (sub == Ralph_G_Degli && bcProj){
        // Add a custom button to the form
        var scriptUrl = url.resolveScript({
          scriptId: 'customscript_bc_rgd_aia_forms',
          deploymentId: 'customdeploy1'
        });


        var buttonScript = "window.open('" + scriptUrl + "&recordid=" + recordId +"', '_blank');";

        form.addButton({
          id: 'custpage_my_button',
          label: 'Print AIA Form',
          functionName: buttonScript
        });
 //     form.removeButton('custpage_print_aia_forms');
      }
    }
  }

  return {
    beforeLoad: beforeLoad
  };
});
