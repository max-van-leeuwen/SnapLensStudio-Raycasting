// @input SceneObject tweenObject
// @input string tweenName

// @output float asFloat
// @output vec2 asVec2
// @output vec3 asVec3
// @output vec4 asVec4

if (!global.tweenManager) {
    print("Tween Manager not initialized. Try moving the TweenManager script to the top of the Objects Panel or triggering this node in \"TurnOnEvent\".");
    return;
}

var result = global.tweenManager.getGenericTweenValue(script.tweenObject, script.tweenName);

script.asFloat = result;
script.asVec2 = result;
script.asVec3 = result;
script.asVec4 = result;