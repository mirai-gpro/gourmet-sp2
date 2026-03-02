import * as THREE from 'three';
export class PoseWrapper {
    static estimate(landmarks: any) {
        return { "Hips": new THREE.Quaternion(), "Neck": new THREE.Quaternion() };
    }
}
