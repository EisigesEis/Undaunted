// Public networking facade. Implementation is split into private fragments so
// every subsystem shares one translation-unit RuntimeState without duplicated
// hook state or changed scheduling order.
#include "Private/RuntimeState.inl"
#include "Private/ConnectionState.inl"
#include "Private/ConsiderCache.inl"
#include "Private/ReplicationScheduler.inl"
#include "Private/ListenDispatch.inl"
