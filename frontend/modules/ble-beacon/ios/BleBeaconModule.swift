import ExpoModulesCore
import CoreBluetooth
import UIKit

// Custom service UUID that ESP32 nodes scan for to identify this iPhone.
// Using a 128-bit UUID to avoid collision with standard BLE services.
// ESP32 firmware must scan for this same UUID.
private let OZZU_SERVICE_UUID = CBUUID(string: "4F5A5A55-5452-4143-4B00-000000000001")
private let OZZU_CHAR_UUID    = CBUUID(string: "4F5A5A55-5452-4143-4B00-000000000002")

public class BleBeaconModule: Module {
    private var peripheralManager: CBPeripheralManager?
    private var delegate: BeaconDelegate?
    private var advertising = false
    private var deviceName: String = "ozzu-phone"

    public func definition() -> ModuleDefinition {
        Name("BleBeacon")

        Events("onStateChange", "onError")

        // Start advertising as a BLE peripheral
        AsyncFunction("startAdvertising") { (name: String, promise: Promise) in
            self.deviceName = name
            self.startBeacon()
            promise.resolve(true)
        }

        // Stop advertising
        Function("stopAdvertising") {
            self.stopBeacon()
        }

        // Check if currently advertising
        Function("isAdvertising") { () -> Bool in
            return self.advertising
        }

        // Check if BLE peripheral is supported
        Function("isAvailable") { () -> Bool in
            guard UIDevice.current.userInterfaceIdiom == .phone else { return false }
            return true
        }
    }

    private func startBeacon() {
        stopBeacon()

        let delegate = BeaconDelegate(module: self)
        self.delegate = delegate
        self.peripheralManager = CBPeripheralManager(delegate: delegate, queue: nil, options: [
            CBPeripheralManagerOptionRestoreIdentifierKey: "ozzu-ble-beacon"
        ])
    }

    private func stopBeacon() {
        if advertising {
            peripheralManager?.stopAdvertising()
            peripheralManager?.removeAllServices()
        }
        advertising = false
        peripheralManager = nil
        delegate = nil
    }

    fileprivate func onPoweredOn() {
        guard let pm = peripheralManager else { return }

        // Create a GATT service with a readable characteristic
        // The characteristic value contains the device name for identification
        let characteristic = CBMutableCharacteristic(
            type: OZZU_CHAR_UUID,
            properties: [.read],
            value: deviceName.data(using: .utf8),
            permissions: [.readable]
        )

        let service = CBMutableService(type: OZZU_SERVICE_UUID, primary: true)
        service.characteristics = [characteristic]
        pm.add(service)

        // Start advertising with the service UUID and local name
        // iOS includes the service UUID in the advertisement so ESP32 can filter on it
        pm.startAdvertising([
            CBAdvertisementDataServiceUUIDsKey: [OZZU_SERVICE_UUID],
            CBAdvertisementDataLocalNameKey: deviceName
        ])

        advertising = true
        sendEvent("onStateChange", ["state": "advertising"])
    }

    fileprivate func onAdvertisingStarted(error: Error?) {
        if let error = error {
            advertising = false
            sendEvent("onError", ["error": error.localizedDescription])
        } else {
            advertising = true
            sendEvent("onStateChange", ["state": "advertising"])
        }
    }

    fileprivate func onStateChange(_ state: CBManagerState) {
        switch state {
        case .poweredOn:
            onPoweredOn()
        case .poweredOff:
            advertising = false
            sendEvent("onStateChange", ["state": "poweredOff"])
        case .unauthorized:
            advertising = false
            sendEvent("onStateChange", ["state": "unauthorized"])
        case .unsupported:
            sendEvent("onStateChange", ["state": "unsupported"])
        default:
            break
        }
    }

    // MARK: - Peripheral Manager Delegate

    private class BeaconDelegate: NSObject, CBPeripheralManagerDelegate {
        weak var module: BleBeaconModule?

        init(module: BleBeaconModule) {
            self.module = module
        }

        func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
            module?.onStateChange(peripheral.state)
        }

        func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
            module?.onAdvertisingStarted(error: error)
        }

        // Handle state restoration (app relaunched in background by iOS)
        func peripheralManager(_ peripheral: CBPeripheralManager, willRestoreState dict: [String : Any]) {
            // iOS restored us — just re-advertise
            module?.onPoweredOn()
        }

        func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
            // Respond to read requests from ESP32 nodes
            if request.characteristic.uuid == OZZU_CHAR_UUID {
                if let value = module?.deviceName.data(using: .utf8) {
                    request.value = value
                    peripheral.respond(to: request, withResult: .success)
                } else {
                    peripheral.respond(to: request, withResult: .unlikelyError)
                }
            } else {
                peripheral.respond(to: request, withResult: .attributeNotFound)
            }
        }
    }
}
