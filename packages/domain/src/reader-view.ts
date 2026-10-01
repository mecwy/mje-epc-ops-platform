/**
 * Photo projections a read-only account (EXECUTIVE_READER) is served (OD20): never a photo's
 * exact coordinates, only whether it has a position and its claimed accuracy; a frozen photo
 * with the link it had in its revision. Used by the report exit (report-reader.ts, which holds
 * the report-day projections of OD18) and by the photo store. Writers are not affected. Pure
 * mapping only.
 */
import type { PhotoAsOfDto, PhotoDto } from '@mje/contracts';

/**
 * OD20: a read-only account sees whether a photo has a position (`location`: device fix, file
 * GPS or none) and the accuracy the device claimed, never where. The capture fix keeps its
 * accuracy and time with lat/lon null, the file GPS is null, and `coordinates` says they are
 * withheld (so a null is not read as "no position"). Every photo a reader is served passes here.
 */
export function withheldCoordinates(p: PhotoDto): PhotoDto {
  return {
    ...p,
    capture: p.capture ? { ...p.capture, lat: null, lon: null } : null,
    file: { ...p.file, gps: null },
    coordinates: 'withheld',
  };
}

/**
 * A frozen photo as a reader sees it: the stored photo with the link it had in the revision
 * (a later relink is not shown), no link version (readers never change links) and no
 * coordinates (OD20). In the revision's order; a frozen id without a row is left out.
 */
export function frozenPhotoViews(
  frozen: PhotoAsOfDto[],
  rows: PhotoDto[],
): PhotoDto[] {
  const byId = new Map(rows.map((p) => [p.id, p]));
  return frozen.flatMap((f) => {
    const photo = byId.get(f.id);
    return photo
      ? [withheldCoordinates({ ...photo, link: f.link, linkVersion: 0 })]
      : [];
  });
}

/** Exactly the fields a submission freezes of a photo (photoAsOf); nothing else is passed on. */
export function frozenPhotoFields(p: PhotoAsOfDto): PhotoAsOfDto {
  return {
    id: p.id,
    source: p.source,
    location: p.location,
    accuracyM: p.accuracyM,
    deviceCapturedAt: p.deviceCapturedAt,
    fileTakenAt: p.fileTakenAt,
    fileTakenLocal: p.fileTakenLocal,
    link: p.link,
  };
}
