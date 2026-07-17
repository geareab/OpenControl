// Shared types. Button/axis IDs use the standard gamepad convention so the
// keymap is controller-agnostic: drivers translate physical buttons
// (A/cross, B/circle, ...) into these logical IDs at the boundary.

export type ButtonId =
  | 'south' // A / cross
  | 'east' // B / circle
  | 'west' // X / square
  | 'north' // Y / triangle
  | 'dpad_up'
  | 'dpad_down'
  | 'dpad_left'
  | 'dpad_right'
  | 'l1'
  | 'r1'
  | 'l2'
  | 'r2'
  | 'l3'
  | 'r3'
  | 'menu' // Menu / Options
  | 'view' // View / Create
  | 'touchpad'

export type AxisId = 'left_x' | 'left_y' | 'right_x' | 'right_y' | 'l2' | 'r2'

export type ControllerType = 'xbox' | 'dualsense' | 'ds4' | 'generic-hid'

export type ControllerEvent =
  | { kind: 'button'; button: ButtonId; pressed: boolean }
  | { kind: 'axis'; axis: AxisId; value: number } // -1.0..1.0 (sticks), 0..1 (triggers)
  | { kind: 'connected'; controllerType: ControllerType }
  | { kind: 'disconnected' }
