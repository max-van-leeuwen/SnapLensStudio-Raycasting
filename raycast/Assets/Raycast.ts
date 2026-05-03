// Raycast custom meshes. Uses Physics Collider shapes.
// by Max van Leeuwen - maxvanleeuwen.com

// Usage
//   const raycaster = Raycast.instance.Create(objects:RenderMeshVisual[], convex=true, offset=0);
//   raycaster.rayScreen(screenPos:vec2, (hitPos:vec3, hit:RayCastHit) => { ... }, () => { ... });
//   raycaster.rayWorld(fromPos:vec3, toPos:vec3, (hitPos:vec3, hit:RayCastHit) => { ... }, () => { ... });
//   raycaster.setDebugDraw(enabled:boolean);
//   raycaster.destroy();

// See Drawing.ts (and its Inspector settings) for usage examples!


class RaycastInstance {
    private objects: RenderMeshVisual[]
    private colliders: ColliderComponent[]
    private offset: number // world units (cm)
    private convex: boolean
    private raycastManager: Raycast

    constructor(objects: RenderMeshVisual[], manager: Raycast, convex: boolean = true, offset: number = 0) {
        this.objects = objects;
        this.colliders = [];
        this.raycastManager = manager;
        this.offset = offset;
        this.convex = convex;
        
        // create colliders once for this raycaster
        for(let i = 0; i < this.objects.length; i++){
            const rmv = this.objects[i];
            const mesh = rmv.mesh
            const collider = rmv.getSceneObject().createComponent("Component.ColliderComponent")
            const meshShape = Shape.createMeshShape() as MeshShape
            meshShape.mesh = mesh
            meshShape.convex = this.convex // convex works better, but some meshes need concave (as well as animated meshes!)
            collider.shape = meshShape
            collider.debugDrawEnabled = false
            this.colliders.push(collider)
        }
    }

    // Enable or disable debug draw on all objects
    setDebugDraw(enabled: boolean) {
        for(let i = 0; i < this.colliders.length; i++){
            this.colliders[i].debugDrawEnabled = enabled;
        }
    }

    // Destroy this raycaster instance and remove all collider components
    destroy() {
        for(let i = 0; i < this.colliders.length; i++){
            this.colliders[i].destroy();
        }
        this.colliders = [];
    }

    // vec2 screen to vec3 world pos
    rayScreen(p:vec2, callback:Function, noneFound:Function) {
        const cam = this.raycastManager.getCamera()!;
        var nearPos = cam.screenSpaceToWorldSpace(p, 0);
        var farPos = cam.screenSpaceToWorldSpace(p, cam.far - cam.near);
        Physics.createGlobalProbe().rayCastAll(nearPos, farPos, (hitResults) => {
            let p
            let hit
            for(let i=0; i < hitResults.length; i++) {
                hit = hitResults[i];
                p = hit.position

                // slightly closer to camera
                if(this.offset > 0){
                    let offset = p.sub(cam.getTransform().getWorldPosition()).normalize().uniformScale(-this.offset)
                    p = p.add(offset)
                }
                break
            }
            if(p){
                callback(p, hit)
            }else{
                noneFound()
            }
        });
    }

    // vec3 world to vec3 world pos raycast
    rayWorld(from:vec3, to:vec3, callback:Function, noneFound:Function) {
        Physics.createGlobalProbe().rayCastAll(from, to, (hitResults) => {
            let p
            let hit
            for(let i=0; i < hitResults.length; i++) {
                hit = hitResults[i];
                p = hit.position

                // slightly back towards starting point
                if(this.offset > 0){
                    let offset = p.sub(from).normalize().uniformScale(-this.offset)
                    p = p.add(offset)
                }
                break
            }
            if(p){
                callback(p, hit)
            }else{
                noneFound()
            }
        });
    }
}

@component
export class Raycast extends BaseScriptComponent {

    private static _instance: Raycast;
    public static get instance(): Raycast {
        return Raycast._instance;
    }

    // store
    private deviceTracking: DeviceTracking | null = null
    private cam: Camera | null = null
    
    onAwake() {
        if (Raycast._instance && Raycast._instance !== this) throw("Multiple Raycast instances detected. Only one should exist in the scene.");
        Raycast._instance = this;

        // get DeviceTracking
        const rootCount = global.scene.getRootObjectsCount();
        for (let i = 0; i < rootCount; i++) {
            this.searchForDeviceTracking(global.scene.getRootObject(i));
            if (this.deviceTracking) break;
        }
        if(this.deviceTracking) this.cam = this.deviceTracking.getSceneObject().getComponent("Component.Camera")
    }

    public Create(objects: RenderMeshVisual[], convex: boolean = true, offset: number = 0): RaycastInstance {
        return new RaycastInstance(objects, this, convex, offset);
    }

    public getCamera(): Camera | null {
        return this.cam;
    }

    private searchForDeviceTracking(obj: SceneObject): void {
        const components = obj.getComponents("Component.DeviceTracking");
        if (components.length > 0) {
            this.deviceTracking = components[0] as DeviceTracking;
            return;
        }
        for (let i = 0; i < obj.getChildrenCount(); i++) {
            this.searchForDeviceTracking(obj.getChild(i));
            if (this.deviceTracking) return;
        }
    }
}
