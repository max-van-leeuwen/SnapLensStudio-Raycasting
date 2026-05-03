// @input Component.MaterialMeshVisual target
// @input vec4 to = {1, 1, 1, 1}  {widget:"color"}
// @input float time

// @input bool waitToPlay = false
// @input bool loop = false
// @input bool yoyo = false

// @input function float(float t) easingFunc

// @output tweenObj tween

// @output execution onComplete

if (!global.tweenManager) {
    print("Tween Manager not initialized. Try moving the TweenManager script to the top of the Objects Panel or triggering this node in \"TurnOnEvent\".");
    return;
}

var time = script.time * 1000;

var pass = script.target.mainPass;

var from = pass.baseColor;
var to = script.to;

var onUpdate = function(obj) {
    pass.baseColor = vec4.lerp(from, to, obj.t);
};

var tween = new TWEEN.Tween({t: 0})
    .to({t: 1}, time)
    .onUpdate(onUpdate);

script.tween = tween;
var st = TWEEN.Tween.prototype.start.bind(tween);
tween.start = function(time) {
    this._object.t = 0;
    st(time);
};


if (script.loop) {
    tween.repeat("Infinity");
}

if (script.yoyo) {
    tween.yoyo(true);
}

tween.easing(script.easingFunc || TWEEN.Easing.Quadratic.Out);

if (!script.waitToPlay) {
    tween.start();
}

if (script.onComplete) {
    tween.onComplete(script.onComplete);
}