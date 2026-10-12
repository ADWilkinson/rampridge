import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { MathUtils } from "three";
import { OsrsCamera, PITCH_MAX, type CameraKey } from "./camera";

const focus = new Vector3(10, 2.4375, -10);

function hold(cam: OsrsCamera, key: CameraKey | null, seconds: number): void {
  if (key) cam.setKey(key, true);
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) cam.update(dt, focus);
  if (key) cam.setKey(key, false);
}

describe("OsrsCamera", () => {
  it("starts south of the player looking north", () => {
    const cam = new OsrsCamera();
    hold(cam, null, 0.1);
    expect(cam.yaw).toBeCloseTo(0);
    expect(cam.camera.position.x).toBeCloseTo(focus.x);
    expect(cam.camera.position.z).toBeGreaterThan(focus.z);
  });

  it("swings west round the player on Left, like the client's camAngleDY toward -24", () => {
    const cam = new OsrsCamera();
    hold(cam, "left", 0.5);
    expect(cam.yaw).toBeLessThan(-0.3);
    expect(cam.camera.position.x).toBeLessThan(focus.x - 1);
  });

  it("swings east on Right", () => {
    const cam = new OsrsCamera();
    hold(cam, "right", 0.5);
    expect(cam.yaw).toBeGreaterThan(0.3);
    expect(cam.camera.position.x).toBeGreaterThan(focus.x + 1);
  });

  it("raises the camera on Up up to the pitch limit", () => {
    const cam = new OsrsCamera();
    hold(cam, null, 0.1);
    const before = cam.camera.position.y;
    hold(cam, "up", 3);
    hold(cam, null, 1);
    expect(cam.camera.position.y).toBeGreaterThan(before);
    expect(cam.pitch).toBeCloseTo(PITCH_MAX, 2);
  });

  it("turns back to north the short way", () => {
    const cam = new OsrsCamera();
    cam.rotateBy(Math.PI * 2 + 0.4, 0);
    cam.snap();
    cam.resetNorth();
    hold(cam, null, 2);
    expect(Math.abs(Math.sin(cam.yaw))).toBeLessThan(1e-3);
    expect(Math.cos(cam.yaw)).toBeGreaterThan(0.999);
  });

  it("frames portrait screens closer and higher until the player picks their own view", () => {
    const cam = new OsrsCamera();
    cam.setViewport(1280, 800);
    cam.snap();
    const desktopZoom = cam.zoom;
    const desktopPitch = cam.pitch;
    cam.setViewport(390, 844);
    cam.snap();
    expect(cam.framing).toBe("portrait");
    expect(cam.zoom).toBeLessThan(desktopZoom);
    expect(cam.pitch).toBeGreaterThan(desktopPitch);
    // A phone held sideways looks a little more downward; a desktop window gets the desktop framing back.
    cam.setViewport(844, 390);
    cam.snap();
    expect(cam.framing).toBe("short");
    expect(cam.zoom).toBeCloseTo(desktopZoom);
    expect(cam.pitch).toBeGreaterThan(desktopPitch);
    cam.setViewport(1440, 900);
    cam.snap();
    expect(cam.zoom).toBeCloseTo(desktopZoom);
    expect(cam.pitch).toBeCloseTo(desktopPitch);
  });

  it("keeps the player's zoom and pitch when the screen turns", () => {
    const cam = new OsrsCamera();
    cam.setViewport(844, 390);
    cam.zoomBy(-2);
    cam.rotateBy(0, 0.1);
    cam.snap();
    const { zoom, pitch } = cam;
    cam.setViewport(390, 844);
    cam.snap();
    expect(cam.zoom).toBeCloseTo(zoom);
    expect(cam.pitch).toBeCloseTo(pitch);
  });

  it("draws the player below the middle in portrait, but not behind the title", () => {
    const cam = new OsrsCamera();
    cam.setViewport(390, 844);
    cam.snap();
    hold(cam, null, 0.1);
    const p = focus.clone();
    p.y += 0.5;
    const ndc = p.project(cam.camera);
    // Below the middle: negative NDC y.
    expect(ndc.y).toBeLessThan(-0.1);
    cam.updateTitle(1 / 60, focus, 12);
    expect(cam.camera.view === null || cam.camera.view.enabled === false).toBe(true);
  });

  describe("arrival framing", () => {
    // The bankers' row from the spawn inside the door: 4.5 tiles east, 5.5 north (north is -z).
    const towards = { dx: 4.5, dz: -5.5 };
    const hall = focus.clone().add(new Vector3(towards.dx, 0, towards.dz));

    function arrive(width: number, height: number): OsrsCamera {
      const cam = new OsrsCamera();
      cam.setViewport(width, height);
      cam.frameArrival(towards.dx, towards.dz);
      cam.snap();
      hold(cam, null, 0.1);
      return cam;
    }

    /** Projects `v` with the camera's current placement (the renderer normally updates its matrices). */
    function project(cam: OsrsCamera, v: Vector3): Vector3 {
      cam.camera.updateMatrixWorld();
      return v.clone().project(cam.camera);
    }

    /** Where the camera looks: the point straight ahead at the focus height. */
    function lookPoint(cam: OsrsCamera): Vector3 {
      return focus.clone().add(cam.lead);
    }

    it("leans a desktop view 2-3 tiles towards the bankers, still facing north", () => {
      const cam = arrive(1440, 900);
      expect(cam.arriving).toBe(true);
      expect(cam.yaw).toBeCloseTo(0);
      const lead = cam.lead.length();
      expect(lead).toBeGreaterThanOrEqual(2);
      expect(lead).toBeLessThanOrEqual(3);
      // North-east: east is +x, north is -z.
      expect(cam.lead.x).toBeGreaterThan(1);
      expect(cam.lead.z).toBeLessThan(-1);
      // The hall is nearer the middle of the view than without the lean.
      const plain = new OsrsCamera();
      plain.setViewport(1440, 900);
      plain.snap();
      hold(plain, null, 0.1);
      const leaned = project(cam, hall);
      const centred = project(plain, hall);
      expect(Math.hypot(leaned.x, leaned.y)).toBeLessThan(Math.hypot(centred.x, centred.y));
    });

    it("leans a sideways phone the same way", () => {
      const cam = arrive(844, 390);
      expect(cam.framing).toBe("short");
      expect(cam.yaw).toBeCloseTo(0);
      expect(cam.lead.length()).toBeGreaterThanOrEqual(2);
    });

    it("turns a portrait view about 20 degrees towards the booths, which stay on screen and left of the minimap", () => {
      const cam = arrive(390, 844);
      expect(cam.framing).toBe("portrait");
      // Negative yaw: the camera swings west of the player, looking north-east.
      expect(MathUtils.radToDeg(cam.yaw)).toBeCloseTo(-20, 0);
      const p = project(cam, hall);
      expect(Math.abs(p.x)).toBeLessThan(0.6);
      expect(Math.abs(p.y)).toBeLessThan(0.9);
      // Without the arrival framing the bankers' row is at the right edge, where the minimap is.
      const plain = new OsrsCamera();
      plain.setViewport(390, 844);
      plain.snap();
      hold(plain, null, 0.1);
      expect(project(plain, hall).x).toBeGreaterThan(p.x + 0.2);
    });

    it("eases the lean out when the player walks, keeping the yaw", () => {
      const cam = arrive(390, 844);
      const yaw = cam.yaw;
      cam.settle();
      expect(cam.arriving).toBe(false);
      hold(cam, null, 0.2);
      // Easing, not a jump.
      expect(cam.lead.length()).toBeGreaterThan(0.2);
      hold(cam, null, 3);
      expect(cam.lead.length()).toBeLessThan(0.01);
      expect(cam.yaw).toBeCloseTo(yaw);
      expect(lookPoint(cam).distanceTo(focus)).toBeLessThan(0.01);
    });

    it("ends when the player drags or rotates the camera", () => {
      const dragged = arrive(1440, 900);
      dragged.rotateBy(0.2, 0);
      expect(dragged.arriving).toBe(false);
      hold(dragged, null, 3);
      expect(dragged.lead.length()).toBeLessThan(0.01);

      const turned = arrive(1440, 900);
      hold(turned, "left", 0.1);
      expect(turned.arriving).toBe(false);

      // Zooming alone keeps the arrival view.
      const zoomed = arrive(1440, 900);
      zoomed.zoomBy(1);
      expect(zoomed.arriving).toBe(true);
    });

    it("follows the screen turning before the player moves, but not after they turned the camera", () => {
      const cam = arrive(390, 844);
      cam.setViewport(844, 390);
      hold(cam, null, 2);
      expect(cam.yaw).toBeCloseTo(0, 2);
      cam.setViewport(390, 844);
      hold(cam, null, 2);
      expect(MathUtils.radToDeg(cam.yaw)).toBeCloseTo(-20, 0);
      cam.rotateBy(0.3, 0);
      hold(cam, null, 1);
      const yaw = cam.yaw;
      cam.setViewport(844, 390);
      hold(cam, null, 1);
      expect(cam.yaw).toBeCloseTo(yaw);
    });

    it("leaves the compass's north turn as it was", () => {
      const cam = arrive(390, 844);
      cam.resetNorth();
      hold(cam, null, 2);
      expect(Math.abs(Math.sin(cam.yaw))).toBeLessThan(1e-3);
    });

    it("does not lean when standing at the point, nor behind the title", () => {
      const cam = new OsrsCamera();
      cam.setViewport(1440, 900);
      cam.frameArrival(0, 0);
      cam.snap();
      expect(cam.arriving).toBe(false);
      expect(cam.lead.length()).toBe(0);

      const titled = arrive(1440, 900);
      titled.updateTitle(1 / 60, focus, 12);
      // The title orbit looks at its own centre, lean or not.
      const centre = focus.clone();
      centre.y += 0.6;
      const p = project(titled, centre);
      expect(Math.abs(p.x)).toBeLessThan(1e-6);
    });
  });
});
