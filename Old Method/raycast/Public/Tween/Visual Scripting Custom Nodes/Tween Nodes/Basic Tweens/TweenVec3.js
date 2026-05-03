// @input vec3 startValue = {0.0, 0.0, 0.0}
// @input vec3 endValue = {1.0, 1.0, 1.0}

// @input float time = 1.0

// @input bool waitToPlay = false
// @input bool loop = false
// @input bool yoyo = false

// @input function float(float t) easingFunc

// @output tweenObj tween
// @output execution void(float vec3) onUpdate
// @output execution onComplete

if (!global.tweenManager) {
    print("Tween Manager not initialized. Try moving the TweenManager script to the top of the Objects Panel or triggering this node in \"TurnOnEvent\".");
    return;
}

var time = (script.time || 1.0) * 1000;

function getFromValue() {
    return {x:script.startValue.x, y:script.startValue.y, z:script.startValue.z};
}
function getToValue() {
    return {x:script.endValue.x, y:script.endValue.y, z:script.endValue.z};
}

var tween = new TWEEN.Tween(getFromValue());
script.tween = tween;

var st = TWEEN.Tween.prototype.start.bind(tween);
tween.start = function(time) {
    this._object = getFromValue();
    st(time);
};

tween.to(getToValue(), time);

if (script.onUpdate) {
    tween.onUpdate(function(obj) { 
        script.onUpdate(new vec3(obj.x, obj.y, obj.z));
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
