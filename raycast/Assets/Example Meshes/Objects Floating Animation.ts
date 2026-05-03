@component
export class ObjectsFloatingAnimation extends BaseScriptComponent {
    @input
    strength: number = 5
    
    @input
    speed: number = 1
    
    @input
    rotationSpeed: number = 0.5

    private floatingObjects: Array<{
        transform: Transform,
        startPos: vec3,
        startRot: quat,
        randomAxis: vec3,
        timeOffset: number
    }> = []

    onAwake() {
        for(let i = 0; i < this.getSceneObject().getChildrenCount(); i++){
            const child = this.getSceneObject().getChild(i)
            const trf = child.getTransform()
            
            this.floatingObjects.push({
                transform: trf,
                startPos: trf.getWorldPosition(),
                startRot: trf.getWorldRotation(),
                randomAxis: vec3.randomDirection(),
                timeOffset: Math.random() * Math.PI * 2
            })
        }

        // Single update event for all objects
        this.createEvent("UpdateEvent").bind(() => {
            const currentTime = getTime()
            
            for(let i = 0; i < this.floatingObjects.length; i++){
                const obj = this.floatingObjects[i]
                
                // up/down
                const verticalOffset = Math.sin(currentTime * this.speed + obj.timeOffset) * this.strength
                const newPos = new vec3(
                    obj.startPos.x,
                    obj.startPos.y + verticalOffset,
                    obj.startPos.z
                )
                obj.transform.setWorldPosition(newPos)
                
                // rotate
                const rotationAngle = currentTime * this.rotationSpeed
                const rotation = quat.angleAxis(rotationAngle, obj.randomAxis)
                obj.transform.setWorldRotation(rotation.multiply(obj.startRot))
            }
        })
    }
}
