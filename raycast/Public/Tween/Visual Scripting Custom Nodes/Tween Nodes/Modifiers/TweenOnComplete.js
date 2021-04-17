// @input tweenObj tweenIn
// @output tweenObj tweenOut
// @output execution onComplete


script.tweenOut = script.tweenIn;
if (script.onComplete) {
    script.tweenIn.onComplete(script.onComplete);
}