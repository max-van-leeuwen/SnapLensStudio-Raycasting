// @input SceneObject tweenObject
// @input string tweenName

if (!global.tweenManager) {
    print("Tween Manager not initialized. Try moving the TweenManager script to the top of the Objects Panel or triggering this node in \"TurnOnEvent\".");
    return;
}

global.tweenManager.resetTween(script.tweenObject, script.tweenName);