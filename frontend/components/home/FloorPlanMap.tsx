import { useState, useCallback } from "react";
import { View, Image, LayoutChangeEvent, ImageLoadEventData, NativeSyntheticEvent } from "react-native";
import { useVacuum } from "../../lib/useVacuum";
import { MAP_PINS, type MapPin } from "../../lib/map-config";
import { DevicePin } from "./DevicePin";

interface FloorPlanMapProps {
  onPinPress: (pin: MapPin) => void;
  onMapLoadError: () => void;
}

export function FloorPlanMap({ onPinPress, onMapLoadError }: FloorPlanMapProps) {
  const { state } = useVacuum();
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [imageNatural, setImageNatural] = useState({ width: 0, height: 0 });

  const onContainerLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setContainerSize({ width, height });
  }, []);

  const onImageLoad = useCallback((e: NativeSyntheticEvent<ImageLoadEventData>) => {
    const { width, height } = e.nativeEvent.source;
    setImageNatural({ width, height });
  }, []);

  if (!state.mapUrl) {
    onMapLoadError();
    return null;
  }

  // Calculate rendered image bounds (resizeMode="contain" letterboxing)
  let renderW = 0, renderH = 0, offsetX = 0, offsetY = 0;
  if (containerSize.width > 0 && imageNatural.width > 0) {
    const imgAspect = imageNatural.width / imageNatural.height;
    const containerAspect = containerSize.width / containerSize.height;

    if (imgAspect > containerAspect) {
      renderW = containerSize.width;
      renderH = containerSize.width / imgAspect;
      offsetX = 0;
      offsetY = (containerSize.height - renderH) / 2;
    } else {
      renderH = containerSize.height;
      renderW = containerSize.height * imgAspect;
      offsetX = (containerSize.width - renderW) / 2;
      offsetY = 0;
    }
  }

  const hasBounds = renderW > 0 && renderH > 0;

  return (
    <View style={{ flex: 1 }} onLayout={onContainerLayout}>
      <Image
        source={{ uri: state.mapUrl }}
        style={{ width: "100%", height: "100%" }}
        resizeMode="contain"
        onLoad={onImageLoad}
        onError={onMapLoadError}
      />

      {/* Device pins overlay */}
      {hasBounds &&
        MAP_PINS.map((pin) => {
          const left = offsetX + (pin.x / 100) * renderW;
          const top = offsetY + (pin.y / 100) * renderH;
          return (
            <View
              key={pin.id}
              style={{
                position: "absolute",
                left: left - 16,
                top: top - 16,
              }}
            >
              <DevicePin pin={pin} onPress={onPinPress} />
            </View>
          );
        })}
    </View>
  );
}
