// @input SceneObject targetObject
// @input vec3 from
// @input float time
// @input bool localSpace

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

var transform = (script.targetObject || script).getTransform();

var from = script.from;
var to = script.localSpace ? transform.getLocalPosition() : transform.getWorldPosition();

var onUpdate;
if (script.localSpace) {
    onUpdate = function(obj) {
        transform.setLocalPosition(vec3.lerp(from, to, obj.t));
    };
} else {
    onUpdate = function(obj) {
        transform.setWorldPosition(vec3.lerp(from, to, obj.t));
    };
}

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