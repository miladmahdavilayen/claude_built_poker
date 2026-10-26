import { expect, test } from '@playwright/test';
import { boneRole } from '../../src/table3d/houseDealer.js';

// Any character can deal (src/table3d/houseDealer.ts): the dealer's moves
// find a model's spine, neck, head and arm bones whatever its rig calls them.

test('bones are recognised across Mixamo, Blender, Unreal and VRM naming', () => {
  const cases: [string, string | null][] = [
    ['mixamorig:RightArm', 'RightArm'],
    ['mixamorigRightForeArm', 'RightForeArm'],
    ['mixamorig1:LeftHand', 'LeftHand'],
    ['mixamorig:Spine2', 'Spine2'],
    ['upper_arm.R', 'RightArm'],
    ['forearm.L', 'LeftForeArm'],
    ['DEF-upper_arm.L', 'LeftArm'],
    ['upperarm_r', 'RightArm'],
    ['lowerarm_l', 'LeftForeArm'],
    ['hand_r', 'RightHand'],
    ['spine_01', 'Spine'],
    ['spine_03', 'Spine2'],
    ['neck_01', 'Neck'],
    ['J_Bip_R_UpperArm', 'RightArm'],
    ['J_Bip_L_LowerArm', 'LeftForeArm'],
    ['J_Bip_C_Head', null],
    ['Head', 'Head'],
    ['mixamorig:LeftShoulder', null],
    ['mixamorig:RightHandIndex1', null],
    ['Hips', null],
    ['clavicle_r', null],
  ];
  for (const [name, role] of cases) expect([name, boneRole(name)]).toEqual([name, role]);
});
