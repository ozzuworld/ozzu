// Exercise Tracker — analyzes pose landmarks for exercise form and rep counting
// Supports: squat, deadlift, pushup detection + form quality scoring

import type { PoseLandmark } from "../modules/expo-mediapipe";

export type ExerciseType = "squat" | "pushup" | "deadlift" | "unknown";
export type FormQuality = "good" | "warning" | "bad";

export interface ExerciseState {
  exercise: ExerciseType;
  reps: number;
  phase: "up" | "down" | "idle"; // current movement phase
  formQuality: FormQuality;
  angle: number; // key angle being tracked (degrees)
  feedback: string; // form feedback text
}

// Pose landmark indices
const NOSE = 0;
const L_SHOULDER = 11;
const R_SHOULDER = 12;
const L_ELBOW = 13;
const R_ELBOW = 14;
const L_WRIST = 15;
const R_WRIST = 16;
const L_HIP = 23;
const R_HIP = 24;
const L_KNEE = 25;
const R_KNEE = 26;
const L_ANKLE = 27;
const R_ANKLE = 28;

function angle3(a: PoseLandmark, b: PoseLandmark, c: PoseLandmark): number {
  const ab = { x: a.x - b.x, y: a.y - b.y };
  const cb = { x: c.x - b.x, y: c.y - b.y };
  const dot = ab.x * cb.x + ab.y * cb.y;
  const magAB = Math.sqrt(ab.x * ab.x + ab.y * ab.y);
  const magCB = Math.sqrt(cb.x * cb.x + cb.y * cb.y);
  if (magAB * magCB === 0) return 0;
  const cosAngle = Math.max(-1, Math.min(1, dot / (magAB * magCB)));
  return (Math.acos(cosAngle) * 180) / Math.PI;
}

// Average left and right side angles
function avgAngle(lm: PoseLandmark[], la: number, lb: number, lc: number, ra: number, rb: number, rc: number): number {
  const left = angle3(lm[la], lm[lb], lm[lc]);
  const right = angle3(lm[ra], lm[rb], lm[rc]);
  return (left + right) / 2;
}

function detectExercise(lm: PoseLandmark[]): ExerciseType {
  const kneeAngle = avgAngle(lm, L_HIP, L_KNEE, L_ANKLE, R_HIP, R_KNEE, R_ANKLE);
  const hipAngle = avgAngle(lm, L_SHOULDER, L_HIP, L_KNEE, R_SHOULDER, R_HIP, R_KNEE);
  const elbowAngle = avgAngle(lm, L_SHOULDER, L_ELBOW, L_WRIST, R_SHOULDER, R_ELBOW, R_WRIST);

  // Pushup: body roughly horizontal (hip angle > 150) + elbow bending
  if (hipAngle > 140 && lm[L_SHOULDER].y > lm[L_HIP].y - 0.1) {
    return "pushup";
  }

  // Squat/deadlift: standing upright with knee bend
  if (kneeAngle < 150) {
    // Deadlift: hip angle < 120 (bending at hips more than knees)
    if (hipAngle < 120 && kneeAngle > 120) return "deadlift";
    return "squat";
  }

  return "unknown";
}

export class ExerciseTracker {
  private state: ExerciseState = {
    exercise: "unknown",
    reps: 0,
    phase: "idle",
    formQuality: "good",
    angle: 0,
    feedback: "",
  };
  private prevAngle = 180;
  private repPhase: "up" | "down" = "up";
  private smoothedAngle = 180;

  getState(): ExerciseState {
    return { ...this.state };
  }

  reset(): void {
    this.state = { exercise: "unknown", reps: 0, phase: "idle", formQuality: "good", angle: 0, feedback: "" };
    this.prevAngle = 180;
    this.repPhase = "up";
    this.smoothedAngle = 180;
  }

  update(landmarks: PoseLandmark[]): ExerciseState {
    if (!landmarks || landmarks.length < 33) return this.state;

    const exercise = detectExercise(landmarks);
    this.state.exercise = exercise;

    if (exercise === "unknown") {
      this.state.phase = "idle";
      this.state.feedback = "";
      return this.state;
    }

    let keyAngle: number;
    let downThreshold: number;
    let upThreshold: number;

    switch (exercise) {
      case "squat":
        keyAngle = avgAngle(landmarks, L_HIP, L_KNEE, L_ANKLE, R_HIP, R_KNEE, R_ANKLE);
        downThreshold = 100; // knee angle below 100 = bottom of squat
        upThreshold = 160; // above 160 = standing
        this.evaluateSquatForm(landmarks, keyAngle);
        break;
      case "pushup":
        keyAngle = avgAngle(landmarks, L_SHOULDER, L_ELBOW, L_WRIST, R_SHOULDER, R_ELBOW, R_WRIST);
        downThreshold = 100;
        upThreshold = 155;
        this.evaluatePushupForm(landmarks, keyAngle);
        break;
      case "deadlift":
        keyAngle = avgAngle(landmarks, L_SHOULDER, L_HIP, L_KNEE, R_SHOULDER, R_HIP, R_KNEE);
        downThreshold = 100;
        upThreshold = 160;
        this.evaluateDeadliftForm(landmarks, keyAngle);
        break;
      default:
        return this.state;
    }

    // Smooth angle (exponential moving average)
    this.smoothedAngle = this.smoothedAngle * 0.6 + keyAngle * 0.4;
    this.state.angle = Math.round(this.smoothedAngle);

    // Rep counting state machine
    if (this.repPhase === "up" && this.smoothedAngle < downThreshold) {
      this.repPhase = "down";
      this.state.phase = "down";
    } else if (this.repPhase === "down" && this.smoothedAngle > upThreshold) {
      this.repPhase = "up";
      this.state.phase = "up";
      this.state.reps++;
    }

    return this.state;
  }

  private evaluateSquatForm(lm: PoseLandmark[], kneeAngle: number): void {
    // Check knee tracking over toes
    const kneeX = (lm[L_KNEE].x + lm[R_KNEE].x) / 2;
    const ankleX = (lm[L_ANKLE].x + lm[R_ANKLE].x) / 2;

    if (kneeAngle < 80) {
      this.state.formQuality = "warning";
      this.state.feedback = "TOO DEEP";
    } else if (Math.abs(kneeX - ankleX) > 0.08) {
      this.state.formQuality = "warning";
      this.state.feedback = "KNEES OVER TOES";
    } else {
      this.state.formQuality = "good";
      this.state.feedback = "GOOD FORM";
    }
  }

  private evaluatePushupForm(lm: PoseLandmark[], elbowAngle: number): void {
    // Check body alignment (hip sag)
    const hipAngle = avgAngle(lm, L_SHOULDER, L_HIP, L_ANKLE, R_SHOULDER, R_HIP, R_ANKLE);
    if (hipAngle < 150) {
      this.state.formQuality = "bad";
      this.state.feedback = "HIP SAG";
    } else if (elbowAngle < 70) {
      this.state.formQuality = "warning";
      this.state.feedback = "TOO LOW";
    } else {
      this.state.formQuality = "good";
      this.state.feedback = "GOOD FORM";
    }
  }

  private evaluateDeadliftForm(lm: PoseLandmark[], hipAngle: number): void {
    // Check back rounding (shoulder-hip-knee alignment)
    const shoulderY = (lm[L_SHOULDER].y + lm[R_SHOULDER].y) / 2;
    const hipY = (lm[L_HIP].y + lm[R_HIP].y) / 2;

    if (shoulderY > hipY + 0.05) {
      this.state.formQuality = "bad";
      this.state.feedback = "ROUND BACK";
    } else {
      this.state.formQuality = "good";
      this.state.feedback = "GOOD FORM";
    }
  }
}
