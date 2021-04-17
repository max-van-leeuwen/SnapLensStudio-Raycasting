// Max van Leeuwen || tw @maksvanleeuwen || ig @max.van.leeuwen || maxvanleeuwen.com
//
// Raycasting on any mesh, muddy solution.
// Returns position and rotation to place an object on the mesh where ray intersects.
//
// Issues:
//  - Mesh UVs are irreversibly overwritten with projected UVs. Duplicate mesh resource if mesh UVs are important.
//  - Raycasting needs a 1-frame-delay, which is why it cannot return a value instantly. It uses a callback function instead.
//
// Usage:
// 	script.api.raycast(callback, renderMeshVisual, startPos, endPos)
// 		callback 			: a function with arguments (position [vec3], rotation [quat]) that will be called when raycast is complete
// 		renderMeshVisual 	: the mesh to raycast
// 		startPos 			: world position start of ray
// 		endPos 				: end position end of ray



script.api.raycast = raycast;



function raycast(callback, renderMeshVisual, startPos, endPos){
	var camObj = global.scene.createSceneObject("raycast_cam");
	var camCom = camObj.createComponent("Component.Camera");
	var camTrf = camObj.getTransform();
	camTrf.setWorldPosition(startPos);
	var lookatDirection = quat.lookAt(endPos.sub(startPos), vec3.up());
	camTrf.setWorldRotation(lookatDirection);

	renderMeshVisual.snap(camCom);

	var pinObj = global.scene.createSceneObject("raycast_pin");
	var pinTrf = pinObj.getTransform();
	var ptm = pinObj.createComponent("Component.PinToMeshComponent");
	ptm.target = renderMeshVisual;
	ptm.orientation = PinToMeshComponent.Orientation.PositionAndDirection;
	ptm.useInterpolatedVertexNormal = true;
	ptm.pinUV = new vec2(.5, .5);

	function doHitTest(){
		var pos = pinTrf.getWorldPosition();
		var rot = pinTrf.getWorldRotation();

		camObj.destroy();
		pinObj.destroy();

		callback(pos, rot);
	}
	delay(doHitTest);
}



function delay(func){
	var wait = 1;
	function onUpdate(){
		if(wait < 1){
			script.removeEvent(waitEvent);
			func();
		}
		wait--;
	}
	var waitEvent = script.createEvent("UpdateEvent");
	waitEvent.bind(onUpdate);
}