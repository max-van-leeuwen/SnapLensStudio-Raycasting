// @input SceneObject tweenObject
// @input string tweenName
// @output execution callback

if (!global.tweenManager) {
    print("Tween Manager not initialized. Try moving the TweenManager script to the top of the Objects Panel or triggering this node in \"TurnOnEvent\".");
    return;
}

global.tweenManager.startTween(script.tweenObject, script.tweenName, script.callback);