// @input float startValue = 0.0
// @input float endValue = 1.0

// @input float time = 1.0

// @input bool waitToPlay = false
// @input bool loop = false
// @input bool yoyo = false

// @input function float(float t) easingFunc

// @output tweenObj tween
// @output execution void(float value) onUpdate
// @output execution onComplete

if (!global.tweenManager) {
    print("Tween Manager not initialized. Try moving the TweenManager script to the top of the Objects Panel or triggering this node in \"TurnOnEvent\".");
    return;
}

var time = (script.time || 1.0) * 1000;

var from = script.startValue;
var to = script.endValue;

var tween = new TWEEN.Tween({t:from});
script.tween = tween;
var st = TWEEN.Tween.prototype.start.bind(tween);
tween.start = function(time) {
    this._object.t = from;
    st(time);
};

tween.to({t: to}, time);

if (script.onUpdate) {
    tween.onUpdate(function(obj) { 
        script.onUpdate(obj.t);
    });
}

if (script.loop) {
    tween.repeat("Infinity");
}

if (script.yoyo) {
    tween.yoyo(true);
}

if (script.easingFunc) {
    tween.easing(script.easingFunc);
}

if (!script.waitToPlay) {
    tween.start();
}

if (script.onComplete) {
    tween.onComplete(script.onComplete);
}
