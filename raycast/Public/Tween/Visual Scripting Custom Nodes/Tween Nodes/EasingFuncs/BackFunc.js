// @output function float(float t) In
// @output function float(float t) Out
// @output function float(float t) InOut

if (!global.tweenManager) {
    print("Tween Manager not initialized. Try moving the TweenManager script to the top of the Objects Panel or triggering this node in \"TurnOnEvent\".");
    return;
}

var p = TWEEN.Easing.Back;
script.In = p.In;
script.Out = p.Out;
script.InOut = p.InOut;
