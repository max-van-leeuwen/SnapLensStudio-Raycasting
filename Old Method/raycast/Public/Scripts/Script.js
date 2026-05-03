// Max van Leeuwen || tw @maksvanleeuwen || ig @max.van.leeuwen || maxvanleeuwen.com
// Uses the raycast module to place the previewObj mesh between the startPos and endPos object on the surface of renderMeshVisual.



//@input Component.Script raycast
//@input SceneObject previewObj
//@input Component.RenderMeshVisual renderMeshVisual
//@input SceneObject startPos
//@input SceneObject endPos



// execute on every frame
function frameUpdate(){
	var startPos = script.startPos.getTransform().getWorldPosition();
	var endPos = script.endPos.getTransform().getWorldPosition();

	script.raycast.api.raycast(callback, script.renderMeshVisual, startPos, endPos);
}
var updateEvent = script.createEvent("UpdateEvent");
updateEvent.bind(frameUpdate);



// function to call when raycast is complete (needs position, rotation arguments)
function callback(position, rotation){
	var previewTrf = script.previewObj.getTransform();
	previewTrf.setWorldPosition(position);
	previewTrf.setWorldRotation(rotation);
}