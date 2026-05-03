# SnapLensStudio-Raycasting
Raycast any mesh!
Works with 3D lines (world space / Spectacles) as well as mobile screen-space positions (tapping).

<br>

![Raycasting](https://github.com/max-van-leeuwen/SnapLensStudio-Raycasting/blob/main/media/Raycast%20Spectacles.gif?raw=true)

## Usage

```typescript
// Create a raycaster instance
const raycaster = Raycast.instance.Create(objects:RenderMeshVisual[], convex=true, offset=0);

// Raycast from screen position (e.g., tap)
raycaster.rayScreen(screenPos:vec2, (hitPos:vec3, hit:RayCastHit) => { ... }, () => { ... });

// Raycast in world space (e.g., 3D line)
raycaster.rayWorld(fromPos:vec3, toPos:vec3, (hitPos:vec3, hit:RayCastHit) => { ... }, () => { ... });

// Enable debug visualization
raycaster.setDebugDraw(enabled:boolean);

// Destroy
raycaster.destroy();
```

> **See `Drawing.ts` (and its Inspector settings) for usage examples!**