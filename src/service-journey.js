"use strict";
const crypto = require("node:crypto");
function fail(message, status = 400) { throw Object.assign(new Error(message), { status, code: "JOURNEY_INVALID" }); }
const DEFAULT_SERVICES = [
  ["check_up_bata_matanda", "Check-Up Bata-Matanda", "Consultation", "1st Floor", "Consultation Room", 30],
  ["complete_laboratory", "Complete Laboratory", "Laboratory Department", "2nd Floor", "Laboratory Department", 45],
  ["two_d_echo", "2D Echo", "Cardiology", "2nd Floor", "2D Echo Room", 30],
  ["digital_xray", "Digital X-Ray", "X-Ray Department", "3rd Floor", "X-Ray Department", 20],
  ["ecg", "ECG", "ECG", "2nd Floor", "ECG Room", 20],
  ["drug_test", "Drug Test", "Laboratory Department", "2nd Floor", "Laboratory Department", 30],
  ["ultrasound_transvaginal", "Ultrasound with Transvaginal", "Ultrasound", "2nd Floor", "Ultrasound Room", 30],
  ["pap_smear", "Pap Smear", "Examination", "2nd Floor", "Examination Room", 30],
  ["circumcision_tuli", "Circumcision (Tuli)", "Minor Surgery", "2nd Floor", "Minor Surgery Room", 45],
  ["vaccination_services", "Vaccination Services", "Treatment", "1st Floor", "Treatment Room", 15],
  ["school_package", "School Package", "Laboratory Department", "2nd Floor", "Laboratory Department", 45],
  ["buntis_package", "Buntis Package", "Consultation", "1st Floor", "Consultation Room", 45],
  ["anti_rabies_vaccine", "Anti-Rabies Vaccine", "Treatment", "1st Floor", "Treatment Room", 15],
  ["anti_tetanus_toxoid", "Anti-Tetanus Toxoid", "Treatment", "1st Floor", "Treatment Room", 15],
  ["employment_package", "Employment Package", "Laboratory Department", "2nd Floor", "Laboratory Department", 45],
  ["blood_chemistry_promo_8_tests", "Blood Chemistry Promo Package (8 Tests)", "Laboratory Department", "2nd Floor", "Laboratory Department", 45],
  ["home_service_available", "Home Service Available", "Home Service", "Mobile Service", "Home Service", 60],
];
function ensureDefaults(root, now = Date.now()) {
  root.services ||= {};
  const existingNames = new Set(catalog(root).map((item) => item.service_name.toLowerCase()));
  let changed = false;
  for (const [id, service_name, department, floor, room, estimated_duration] of DEFAULT_SERVICES) {
    if (root.services[id] || existingNames.has(service_name.toLowerCase())) continue;
    root.services[id] = {
      service_id: id, service_name, name: service_name, department, floor, room, estimated_duration,
      status: "active", createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    };
    existingNames.add(service_name.toLowerCase());
    changed = true;
  }
  return changed;
}
function catalog(root) { return Object.entries(root.services || {}).filter(([,s]) => s && typeof s === "object").map(([id,s]) => ({ ...s, service_id: id, service_name: s.service_name || s.name || s.serviceName || "" })); }
function service(root, id) { return catalog(root).find(s => s.service_id === id); }
function appointmentRecord(root, value) {
  const appointments = root.appointments || {};
  if (value && typeof value === "object") {
    const directObject = Object.entries(appointments).find(([, candidate]) => candidate === value);
    if (directObject) return { appointment: directObject[1], recordId: directObject[0] };
    value = value.appointmentRecordId || value.id || value.appointmentId || value.appointmentNumber || value.ref || value.referenceId;
  }
  const reference = String(value || "");
  if (!reference) return { appointment: null, recordId: "" };
  const direct = appointments[reference];
  if (direct && typeof direct === "object") return { appointment: direct, recordId: reference };
  const match = Object.entries(appointments).find(([, candidate]) => candidate && typeof candidate === "object" && [
    candidate.id,
    candidate.appointmentId,
    candidate.appointmentNumber,
    candidate.ref,
    candidate.referenceId,
  ].some((candidateReference) => String(candidateReference || "") === reference));
  return match ? { appointment: match[1], recordId: match[0] } : { appointment: null, recordId: "" };
}
function appointmentFor(root, value) { return appointmentRecord(root, value).appointment; }
function appointmentRecordId(root, value) { return appointmentRecord(root, value).recordId; }
function entryAppointment(root, entry) { return appointmentFor(root, entry?.appointmentRecordId || entry?.appointmentId || entry?.appointmentInternalId); }
function validateService(id, input) {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(id)) fail("Invalid service ID.");
  const row = { service_id: id };
  for (const key of ["service_name", "floor", "room", "department"]) {
    row[key] = String(input[key] || "").trim().slice(0,160);
    if (!row[key]) fail("Enter the service name, floor, room and department.");
  }
  row.estimated_duration = Number(input.estimated_duration);
  if (!Number.isInteger(row.estimated_duration) || row.estimated_duration < 1 || row.estimated_duration > 480) fail("Duration must be 1–480 minutes.");
  if (!["active","inactive"].includes(input.status)) fail("Choose Active or Inactive.");
  row.status = input.status; row.name = row.service_name;
  return row;
}
function plan(root, appointment, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 20 || new Set(ids).size !== ids.length) fail("Choose 1–20 different services in visit order.");
  const selected = ids.map(id => service(root,id));
  if (selected.some(s => !s || s.status !== "active" || !s.floor || !s.room)) fail("Every selected service needs an active, configured clinic location.");
  if (selected[0].service_name !== appointment.serviceName) fail("The first service must match the booked service.");
  root.appointmentServices ||= {};
  appointment.serviceIds = ids;
  ids.forEach((id,index) => {
    const key = 'as_' + crypto.createHash('sha256').update(appointment.id+':'+index).digest('hex').slice(0,32);
    root.appointmentServices[key] = { appointment_service_id:key, appointment_id:appointment.id, service_id:id, sequence_number:index+1, queue_number:"", queue_status:"waiting", started_at:null, completed_at:null };
  });
}
function steps(root, appointmentId) { return Object.values(root.appointmentServices || {}).filter(s => s.appointment_id === appointmentId).sort((a,b)=>a.sequence_number-b.sequence_number); }
function decorate(root, entry) {
  const appointment = entryAppointment(root, entry);
  const list = steps(root,entry.appointmentId || appointment?.id || entry.appointmentRecordId);
  const current = list.find(s => !s.completed_at) || list.at(-1);
  if (!current) return entry;
  const location = service(root,current.service_id) || {};
  const next = list.find(s => s.sequence_number > current.sequence_number);
  const nextLocation = next ? service(root,next.service_id) || {} : {};
  const assigned = Number(current.sequence_number) === 1 ? {
    floor: appointment?.destinationFloor || location.floor || "",
    room: appointment?.destinationRoom || location.room || "",
    department: appointment?.destinationDepartment || location.department || "",
  } : location;
  Object.assign(entry,{ appointmentServiceId:current.appointment_service_id, serviceId:current.service_id, serviceName:location.service_name || entry.serviceName, floor:assigned.floor || "", room:assigned.room || "", department:assigned.department || "", nextService:nextLocation.service_name || "", nextFloor:nextLocation.floor || "", nextRoom:nextLocation.room || "" });
  return entry;
}
function initialize(root, appointment, entry) {
  const recordId = appointmentRecordId(root, appointment);
  if (recordId) entry.appointmentRecordId = recordId;
  if (!steps(root,appointment.id).length) {
    const primary=catalog(root).find(s=>s.status === 'active' && s.service_name === appointment.serviceName && s.floor && s.room);
    if (appointment.serviceIds?.length) plan(root,appointment,appointment.serviceIds);
    else if(primary) plan(root,appointment,[primary.service_id]);
  }
  const current=steps(root,appointment.id).find(s=>!s.completed_at);
  if(current) current.queue_number=entry.queueNo;
  decorate(root,entry);
}
function update(root, entry, input, actor, now) {
  const list=steps(root,entry.appointmentId);
  if(!list.length) return false;
  const current=list.find(s=>!s.completed_at);
  if (!current) {
    if (input.status === 'done' || input.status === 'completed') {
      // A previous appointment update can finish the service steps before the
      // corresponding queue write reaches RTDB. Treat a later Complete Visit
      // click as an idempotent repair: close the stale serving row too.
      entry.status='done';
      entry.journeyStatus='completed';
      const appointment=entryAppointment(root,entry);
      if (appointment) {
        appointment.status='completed';
        appointment.appointmentStatus='completed';
        appointment.completedAt ||= new Date(now).toISOString();
        appointment.updatedAt=new Date(now).toISOString();
      }
      return true;
    }
    fail('This visit is already completed.',409);
  }
  if(input.appointmentServiceId && input.appointmentServiceId !== current.appointment_service_id) fail('The active service changed. Refresh the queue.',409);
  const timestamp=new Date(now).toISOString();
  if(['done','completed'].includes(input.status)) {
    if(!input.appointmentServiceId) fail('Reload the queue before completing this service.',409);
    if(!['in_service','serving'].includes(entry.status)) fail('Start the service before completing it.',409);
    const remaining = list.find(s=>s.sequence_number > current.sequence_number && !s.completed_at);
    if (remaining && service(root,remaining.service_id)?.status !== 'active') fail('The next service is inactive. Ask Admin to update the service before transfer.',409);
    current.queue_status='completed'; current.completed_at=timestamp;
    const next=list.find(s=>!s.completed_at);
    const appointment=entryAppointment(root,entry);
    if (!appointment) fail('Appointment not found. Refresh the queue.',404);
    if(next) {
      next.queue_number=entry.queueNo; next.queue_status='transferred_to_next_service';
      entry.status='waiting'; entry.journeyStatus='transferred_to_next_service';
      entry.previousService=service(root,current.service_id)?.service_name || entry.serviceName;
      entry.sequence=Math.max(...Object.values(root.queueEntries).map(e=>Number(e.sequence)||0))+1;
      entry.checkedInAt=timestamp;
      appointment.status='in_progress'; appointment.appointmentStatus='in_progress';
    } else {
      entry.status='done'; entry.journeyStatus='completed';
      appointment.status='completed'; appointment.appointmentStatus='completed'; appointment.completedAt=timestamp;
    }
    appointment.updatedAt=timestamp;
    decorate(root,entry);
    root.notifications ||= {};
    const id='transfer_'+current.appointment_service_id;
    root.notifications[id]={id,userId:appointment.userId || appointment.patientUserId,type:'queue',referenceId:appointment.id,referenceType:'appointment',title:next?'Next service':'Visit completed',message:next?`Your ${entry.previousService} is complete. Please proceed to ${entry.floor} – ${entry.room}.`:'All services for your visit are complete.',isRead:false,read:false,createdAt:timestamp,updatedAt:timestamp};
    return true;
  }
  if(input.status) {
    current.queue_status=input.status;
    entry.journeyStatus=input.status;
    if(['in_service','serving'].includes(input.status)) current.started_at ||= timestamp;
  }
  return false;
}
module.exports={catalog,service,appointmentFor,appointmentRecordId,validateService,ensureDefaults,plan,steps,decorate,initialize,update};
