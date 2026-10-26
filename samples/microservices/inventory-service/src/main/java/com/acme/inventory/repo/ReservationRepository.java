package com.acme.inventory.repo;

import org.springframework.data.repository.CrudRepository;

public interface ReservationRepository extends CrudRepository<Reservation, Long> {
    void deleteByOrderId(Long orderId);
}
