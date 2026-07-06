// Raycast Examples
// - Screen Space (tap to shoot ray)
// - SIK Hand Tracking (point index finger to shoot ray, both hands)


import { Raycast } from "Raycast.lspkg/Raycast"

@component
export class RaycastExample extends BaseScriptComponent {
    
    @input
    @widget(
        new ComboBoxWidget([
            new ComboBoxItem('screen tap', 'screenTap'),
            new ComboBoxItem('hand pinch', 'handPinch'),
        ])
    )
    inputType: string = 'screenTap';

    @input
    flagLeft!: SceneObject

    @input
    flagRight!: SceneObject

    @input
    raycastObjects!: RenderMeshVisual[]

    // store
    private raycaster: any
    private leftHand: any
    private rightHand: any
    private maxRayDistance = 10000

    onAwake() {
        this.flagLeft.enabled = false
        this.flagRight.enabled = false
        
        if(this.inputType === "screenTap"){
            this.raycaster = Raycast.instance.Create(this.raycastObjects, true, 0.5) // give objects, convex meshes, move slightly closer to the camera

            this.createEvent("TouchStartEvent").bind(this.onTouch.bind(this))
            this.createEvent("TouchMoveEvent").bind(this.onTouch.bind(this))
            this.createEvent("TouchEndEvent").bind(this.onLeftNotFound.bind(this)) // use left-handed for touch

        }else if(this.inputType === "handPinch"){
            this.raycaster = Raycast.instance.Create(this.raycastObjects, true, 1) // give objects, convex meshes, move slightly away from mesh to avoid intersection

            try {
                const { SIK } = require('SpectaclesInteractionKit.lspkg/SIK');
                let handInputData = SIK.HandInputData;
                this.leftHand = handInputData.getHand('left');
                this.rightHand = handInputData.getHand('right');

                this.createEvent("UpdateEvent").bind(this.indexFingerLaser.bind(this))
            } catch (error) {
                print("Add SpectaclesInteractionKit to use hand tracking on the Spectacles.");
            }
        }
    }

    indexFingerLaser() {
        if (!this.leftHand || !this.rightHand) {
            return;
        }
        
        // left hand
        let leftTargetingData = this.leftHand.targetingData;
        if (leftTargetingData && leftTargetingData.intendsToTarget) {
            let leftOrigin = leftTargetingData.targetingLocusInWorld;
            let leftDir = leftTargetingData.targetingDirectionInWorld;
            let leftFar = leftOrigin.add(leftDir.uniformScale(this.maxRayDistance));
            this.raycaster.rayWorld(leftOrigin, leftFar, this.onLeftFound.bind(this), this.onLeftNotFound.bind(this));
        }
        
        // right hand
        let rightTargetingData = this.rightHand.targetingData;
        if (rightTargetingData && rightTargetingData.intendsToTarget) {
            let rightOrigin = rightTargetingData.targetingLocusInWorld;
            let rightDir = rightTargetingData.targetingDirectionInWorld;
            let rightFar = rightOrigin.add(rightDir.uniformScale(this.maxRayDistance));
            this.raycaster.rayWorld(rightOrigin, rightFar, this.onRightFound.bind(this), this.onRightNotFound.bind(this));
        }
    }

    onTouch(args:any) {
        let p = args.getTouchPosition()
        this.raycaster.rayScreen(p, this.onLeftFound.bind(this), this.onLeftNotFound.bind(this))
    }

    onLeftFound(p:vec3, hit:RayCastHit) {
        this.flagLeft.enabled = true

        // place and orient flag
        this.flagLeft.getTransform().setWorldPosition(p)
        const normal = hit.normal
        const rotation = quat.rotationFromTo(new vec3(0, 1, 0), normal)
        this.flagLeft.getTransform().setWorldRotation(rotation)
    }

    onRightFound(p:vec3, hit:RayCastHit) {
        this.flagRight.enabled = true

        // place and orient flag
        this.flagRight.getTransform().setWorldPosition(p)
        const normal = hit.normal
        const rotation = quat.rotationFromTo(new vec3(0, 1, 0), normal)
        this.flagRight.getTransform().setWorldRotation(rotation)
    }

    onLeftNotFound() {
        this.flagLeft.enabled = false
    }
    onRightNotFound() {
        this.flagRight.enabled = false
    }
}