# SnapLensStudio-Raycasting
Raycast any mesh to get the position and rotation. [From this tweet](https://twitter.com/maksvanleeuwen/status/1383471889016754180). 
Uses the PinToMesh component in combination with the snap() function to do a hit test on a 3D model.

<br>

![Raycasting](https://github.com/max-van-leeuwen/SnapLensStudio-Raycasting/blob/main/media/ray%20casting.gif?raw=true)

<br>

```
Raycasting on any mesh, muddy solution.
Returns position and rotation to place an object on the mesh where ray intersects.

Issues:
 - Mesh UVs are irreversibly overwritten with projected UVs. Duplicate mesh resource if mesh UVs are important.
 - Raycasting needs a delay, which is why it cannot return a value instantly. It uses a callback function instead.

Usage:
	script.api.raycast(callback, renderMeshVisual, startPos, endPos)
		callback 			: a function with arguments (position [vec3], rotation [quat]) that will be called when raycast is complete
		renderMeshVisual 		: the mesh to raycast
		startPos 			: world position start of ray
		endPos 				: end position end of ray
