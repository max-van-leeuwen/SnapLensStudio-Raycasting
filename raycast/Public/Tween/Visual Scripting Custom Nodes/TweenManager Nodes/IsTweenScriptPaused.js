// @input SceneObject tweenObject
// @input string tweenName
// @output bool isPaused

if (!global.tweenManager) {
    print("Tween Manager not initialized. Try moving the TweenManager script to the top of the Objects Panel or triggering this node in \"TurnOnEvent\".");
    return;
}

script.isPaused = global.tweenManager.isPaused(script.tweenObject, script.tweenName);