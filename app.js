/////////////////////
// Start/Stop Button logic
/////////////////////
document.addEventListener("DOMContentLoaded", () => {

appState = {
    mode: "idle",
}

const startBtn = document.getElementById("top-bar-start-btn");
const stopBtn = document.getElementById("stop-btn");
const drivingMode = document.getElementById("driving-mode");

startBtn.addEventListener("click", () => {
    appState.mode = "driving";
    drivingMode.classList.remove("hidden");
});

stopBtn.addEventListener("click", () => {
    if (!confirm("Stop driving?")) return;
    appState.mode = "idle";
    drivingMode.classList.add("hidden");
});
});