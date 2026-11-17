import { requireNativeModule } from 'expo-modules-core';
import type { DeviceKeyNative } from './DeviceKey.types';

// Swift: ios/DeviceKeyModule.swift · Kotlin: android/.../DeviceKeyModule.kt
export default requireNativeModule<DeviceKeyNative>('DeviceKey');
