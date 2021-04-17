# SnapLensStudio-Raycasting
Raycast any mesh and retrieve positional and rotational information.



[twitter @maksvanleeuwen](https://twitter.com/maksvanleeuwen)  
[instagram @max.van.leeuwen](https://instagram.com/max.van.leeuwen)  
[maxvanleeuwen.com](https://maxvanleeuwen.com/)  



```
Raycasting on any mesh, muddy solution.
Returns position and rotation to place an object on the mesh where ray intersects.

Issues:
 - Mesh UVs are irreversibly overwritten with projected UVs. Duplicate mesh resource if mesh UVs are important.
 - Raycasting needs a 1-frame-delay, which is why it cannot return a value instantly. It uses a callback function instead.

Usage:
	script.api.raycast(callback, renderMeshVisual, startPos, endPos)
		callback 			: a function with arguments (position [vec3], rotation [quat]) that will be called when raycast is complete
		renderMeshVisual 	: the mesh to raycast
		startPos 			: world position start of ray
		endPos 				: end position end of ray
